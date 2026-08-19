#!/usr/bin/env python3
"""Zelos Packet Capture extension - live network capture and pcap decode."""

import logging
from pathlib import Path

import rich_click as click
from zelos_sdk.hooks.logging import TraceLoggingHandler

from zelos_extension_packet import cli as cli_commands

# Configure rich-click
click.rich_click.USE_RICH_MARKUP = True
click.rich_click.USE_MARKDOWN = True
click.rich_click.SHOW_ARGUMENTS = True
click.rich_click.GROUP_ARGUMENTS_OPTIONS = True
click.rich_click.STYLE_ERRORS_SUGGESTION = "yellow italic"

# INFO level keeps debug chatter out of the backend.
logging.basicConfig(level=logging.INFO)

handler = TraceLoggingHandler("packet_log")
handler.setLevel(logging.INFO)
logging.getLogger().addHandler(handler)


@click.group(invoke_without_command=True)
@click.option(
    "--file",
    type=click.Path(path_type=Path),
    default=None,
    is_flag=False,
    flag_value=".",
    help="Record trace to .trz file (defaults to UTC.trz if no filename specified)",
)
@click.pass_context
def cli(ctx: click.Context, file: Path | None) -> None:
    """Network packet capture and decode.

    With no subcommand this runs in app-config mode - the way the Zelos
    supervisor launches it - reading `config.json` against `config.schema.json`.
    """
    if ctx.invoked_subcommand is not None:
        return
    cli_commands.run_app_mode(file)


cli.add_command(cli_commands.interfaces_cmd)
cli.add_command(cli_commands.check_cmd)
cli.add_command(cli_commands.capture_cmd)
cli.add_command(cli_commands.replay_cmd)
cli.add_command(cli_commands.convert_cmd)


if __name__ == "__main__":
    cli()
