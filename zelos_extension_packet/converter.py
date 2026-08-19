"""pcap -> .trz conversion, shared by the `convert` CLI command and the
`Convert Pcap` action so the two surfaces cannot diverge.

Distinct from `capture.replay_pcap`, which decodes into the *live* namespace so
rows stream to a running agent. Conversion produces a file and nothing else: it
builds its own `TraceNamespace` + `TraceWriter`, so `zelos_sdk.init()` never
runs, no publish client is stood up, and no agent has to be reachable.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from functools import cache
from pathlib import Path
from typing import Any

from .capture import ConfigError, make_decoder

logger = logging.getLogger(__name__)

SUPPORTED_FORMATS = (".pcap", ".pcapng")

#: How often the in-file bar samples the decoder. Cheap (a counter read), but
#: not free (a GIL acquire per sample), so it is not a tight loop.
_POLL_INTERVAL_S = 0.25


# ─── Progress (tqdm is optional) ────────────────────────────────────────────


@cache
def _tqdm() -> Any:
    """The `tqdm` class, or None. Absence is a logged hint, never an error.

    Cached so the hint is logged once per process rather than once per file.
    """
    try:
        from tqdm import tqdm
    except ImportError:
        logger.info("Install tqdm for progress bars: pip install zelos-extension-packet[cli]")
        return None
    return tqdm


@contextmanager
def _tqdm_logging() -> Iterator[None]:
    """Keep log lines from smearing an active bar, when tqdm is present."""
    try:
        from tqdm.contrib.logging import logging_redirect_tqdm
    except ImportError:
        yield
        return
    with logging_redirect_tqdm():
        yield


@contextmanager
def _packet_progress(decoder: Any, input_file: Path, *, enabled: bool) -> Iterator[None]:
    """Poll `decoder.metrics()` from a daemon thread while `convert_file` blocks.

    `convert_file` is a single Rust call that releases the GIL and returns only
    at the end, so there is no Python-side loop to count. `metrics()` reads the
    shared counters without taking the codec lock, so it stays answerable for
    the whole decode - that is what makes polling viable at all.

    The bar deliberately has **no total**: the decoder counts packets, and
    packets are not derivable from a file size without inventing an average
    frame length. It is an honest indeterminate counter; the file size goes in
    the label instead, so the scale is still visible.
    """
    tqdm_cls = _tqdm() if enabled else None
    if tqdm_cls is None:
        yield
        return

    size_mb = input_file.stat().st_size / 1e6
    bar = tqdm_cls(unit="pkt", unit_scale=True, desc=f"{input_file.name} ({size_mb:.1f} MB)")
    done = threading.Event()

    def poll() -> None:
        seen = 0
        while not done.wait(_POLL_INTERVAL_S):
            received = decoder.metrics().packets_received
            bar.update(received - seen)
            seen = received

    thread = threading.Thread(target=poll, name="pcap-progress", daemon=True)
    thread.start()
    try:
        yield
    finally:
        # Join before the final read: the poller owns `bar` until it stops, and
        # two threads updating one bar double-counts. Joining also runs on the
        # exception path, so a failed decode leaves no orphan thread.
        done.set()
        thread.join(timeout=1.0)
        bar.update(decoder.metrics().packets_received - bar.n)
        bar.close()


def _track_files(files: list[Path], *, enabled: bool) -> Iterable[Path]:
    """One bar over the file list, in batch mode."""
    tqdm_cls = _tqdm() if enabled else None
    if tqdm_cls is None:
        return files
    return tqdm_cls(files, unit="file", desc="Converting")


# ─── Path resolution ────────────────────────────────────────────────────────


def expand_inputs(paths: Iterable[str | Path]) -> list[Path]:
    """Resolve CLI/action inputs to a list of capture files.

    A directory expands to the `.pcap`/`.pcapng` files directly inside it (not
    recursive - a recursive sweep of a home directory is not what anyone means
    by `convert ~`). Globs are already expanded by the shell. Duplicates are
    dropped so `convert *.pcap dump.pcap` does not write one output twice.
    """
    resolved: list[Path] = []
    for raw in paths:
        path = Path(raw).expanduser()
        if path.is_dir():
            found = sorted(p for p in path.iterdir() if p.suffix.lower() in SUPPORTED_FORMATS)
            if not found:
                raise ConfigError(f"No {' or '.join(SUPPORTED_FORMATS)} files in {path}")
            resolved.extend(found)
        else:
            resolved.append(path)

    seen: set[Path] = set()
    unique: list[Path] = []
    for path in resolved:
        if path not in seen:
            seen.add(path)
            unique.append(path)
    return unique


def resolve_output(
    input_file: Path,
    output: Path | None = None,
    *,
    output_dir: Path | None = None,
    overwrite: bool = False,
) -> Path:
    """Where one input's `.trz` goes. Defaults to the input with a `.trz` suffix.

    Raises:
        ValueError: the resolved output is the input file.
        FileExistsError: the output exists and `overwrite` is False. In a batch
            this fails one file, not the run - two inputs with the same stem in
            different directories collide here rather than silently clobbering.
    """
    if output is not None:
        out = Path(output).expanduser()
    elif output_dir is not None:
        out = Path(output_dir).expanduser() / input_file.name
    else:
        out = input_file

    if out.suffix.lower() != ".trz":
        out = out.with_suffix(".trz")
    if out == input_file:
        raise ValueError(f"Output path is the input file: {out}")
    if out.exists():
        if not overwrite:
            raise FileExistsError(f"Output exists: {out} (use --force / enable Overwrite)")
        out.unlink()
    return out


# ─── Conversion ─────────────────────────────────────────────────────────────


def convert_pcap(
    input_file: str | Path,
    output_file: str | Path,
    *,
    log_frames: bool = True,
    progress: bool = False,
) -> dict[str, Any]:
    """Convert one pcap/pcapng to `output_file`. No agent, no `zelos_sdk.init()`.

    Raises:
        FileNotFoundError: the input does not exist.
        ValueError: the input is not a `.pcap`/`.pcapng`.
    """
    import zelos_sdk

    source = Path(input_file).expanduser()
    destination = Path(output_file).expanduser()
    if not source.is_file():
        raise FileNotFoundError(f"Input file not found: {source}")
    if source.suffix.lower() not in SUPPORTED_FORMATS:
        raise ValueError(
            f"Unsupported format {source.suffix!r}. Supported: {', '.join(SUPPORTED_FORMATS)}"
        )
    destination.parent.mkdir(parents=True, exist_ok=True)

    logger.info("Converting %s -> %s", source, destination)
    # Its own namespace and writer: converted rows never mix with live data, and
    # nothing here needs the global namespace `init()` would create.
    namespace = zelos_sdk.TraceNamespace("converter")
    try:
        with zelos_sdk.TraceWriter(str(destination), namespace=namespace):
            # `cached=False`: nothing reads a last value out of a file
            # conversion, and only a plain TraceSource takes the batch emit.
            decoder = make_decoder(
                source.stem, log_frames=log_frames, namespace=namespace, cached=False
            )
            with _packet_progress(decoder, source, enabled=progress):
                packets = decoder.convert_file(str(source))
            decoder.flush()
    except KeyboardInterrupt:
        # A deliberate abort is not a failure: the rows drained so far are a
        # valid trace (the package aborts between batches), and whoever hits
        # Ctrl-C at minute 25 of a long convert wants those 25 minutes.
        logger.error("Aborted; partial trace kept: %s", destination)
        raise
    except BaseException:
        # The writer creates the file before the first packet is decoded, so a
        # FAILED decode would otherwise leave a stub .trz that looks exactly
        # like a successful conversion of an empty capture. A partial trace
        # from an error is worse than none: delete it and let the caller
        # decide. `resolve_output` guarantees this path was ours to write.
        destination.unlink(missing_ok=True)
        logger.error("Conversion of %s failed; removed partial %s", source.name, destination)
        raise

    logger.info("Converted %s: %d packets -> %s", source.name, packets, destination)
    return {
        "status": "success",
        "input_file": str(source),
        "output_file": str(destination),
        "packets": packets,
    }


def convert_paths(
    inputs: Iterable[str | Path],
    *,
    output: Path | None = None,
    output_dir: Path | None = None,
    log_frames: bool = True,
    overwrite: bool = False,
    progress: bool = False,
) -> list[dict[str, Any]]:
    """Convert every input to its own `.trz`. One input file, one output file.

    Merging is not done here on purpose: `zelos trace merge` already exists, and
    a batch that silently fused unrelated captures would be unrecoverable.

    A failure converts to a result entry rather than aborting the batch - a
    truncated capture in the middle of an overnight directory must not cost the
    other files.
    """
    files = expand_inputs(inputs)
    if not files:
        raise ConfigError("No input files given")
    if output is not None and len(files) > 1:
        raise ConfigError(
            f"--output names a single file but {len(files)} inputs were given; "
            "use --output-dir for a batch"
        )

    results: list[dict[str, Any]] = []
    with _tqdm_logging():
        for path in _track_files(files, enabled=progress and len(files) > 1):
            try:
                destination = resolve_output(
                    path, output, output_dir=output_dir, overwrite=overwrite
                )
                results.append(
                    convert_pcap(path, destination, log_frames=log_frames, progress=progress)
                )
            except Exception as exc:
                # Any failure, deliberately: this is the isolation boundary that
                # keeps one bad file from ending the batch.
                logger.error("Conversion of %s failed: %s", path, exc)
                results.append(
                    {
                        "status": "error",
                        "input_file": str(path),
                        "message": f"{type(exc).__name__}: {exc}",
                    }
                )
    return results
