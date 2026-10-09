import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FRAME_HEX_MAX_BYTES, FrameHexView } from "../frame-hex-view";
import { parseFrameHex } from "../hex-bytes";

/** The dump as text. There is one layout implementation — the spans — so this is what it renders. */
function dumpLines(hex: string): string[] {
  render(<FrameHexView hex={hex} />);
  return (screen.getByTestId("frame-hex-view").textContent ?? "").split("\n");
}

describe("parseFrameHex", () => {
  it("decodes the `0x…` string the query layer hex-encodes binary columns into, or nothing at all", () => {
    expect([...parseFrameHex("0x00ff10")]).toEqual([0x00, 0xff, 0x10]);
    expect([...parseFrameHex("00FF")]).toEqual([0x00, 0xff]);
    // A garbled cell must read as "no frame", never as plausible-looking wrong bytes.
    for (const bad of ["", "0x", "0xabc", "0xzz"]) expect(parseFrameHex(bad)).toHaveLength(0);
  });
});

describe("the hex dump layout", () => {
  it("lays out offset, 16 hex bytes and the ASCII gutter, padding a short last line", () => {
    const hex = `0x${[...Array(18).keys()].map((i) => (0x41 + i).toString(16)).join("")}`;
    const lines = dumpLines(hex);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("0000  41 42 43 44 45 46 47 48 49 4a 4b 4c 4d 4e 4f 50  ABCDEFGHIJKLMNOP");
    // The short line's hex field keeps its width, so the ASCII gutter stays in the same column.
    expect(lines[1]).toBe("0010  51 52                                            QR");
  });

  it("renders unprintable bytes as dots and keeps a space a space", () => {
    // NUL and DEL are unprintable and become dots; 0x20 is a space and stays one.
    const line = dumpLines("0x007f20")[0] ?? "";
    expect(line.startsWith("0000  00 7f 20")).toBe(true);
    expect(line.slice(-3)).toBe(".. ");
  });
});

describe("FrameHexView", () => {
  it("caps the dump and says how much it left out", () => {
    render(<FrameHexView hex={`0x${"ab".repeat(FRAME_HEX_MAX_BYTES + 32)}`} />);
    expect(screen.getByTestId("frame-hex-view").textContent).toContain("… 32 more bytes");
  });

  it("says the capture hit its snaplen, so a short dump isn't read as a whole frame", () => {
    render(<FrameHexView hex="0x41424344" truncated={true} capLen={4} origLen={1514} />);
    expect(screen.getByText("truncated at snaplen (4 of 1514 bytes captured)")).toBeTruthy();
  });

  it("highlights the selected node's bytes and reports the byte that was clicked", () => {
    const onSelectByte = vi.fn();
    render(<FrameHexView hex="0x41424344" selection={{ offset: 1, len: 2 }} onSelectByte={onSelectByte} />);

    // Two spans per byte: the hex pair and its ASCII character, both selectable and both highlighted.
    const cells = screen.getByTestId("frame-hex-view").querySelectorAll("span[data-offset]");
    expect(cells).toHaveLength(8);
    expect([...cells].filter((cell) => cell.className !== "").map((cell) => cell.getAttribute("data-offset"))).toEqual([
      "1",
      "2",
      "1",
      "2",
    ]);

    fireEvent.click(cells[3] as HTMLElement);
    expect(onSelectByte).toHaveBeenCalledWith(3);
  });

  it("says so when there are no bytes at all", () => {
    render(<FrameHexView hex="" />);
    expect(screen.queryByTestId("frame-hex-view")).toBeNull();
    expect(screen.getByText(/No frame bytes/)).toBeTruthy();
  });
});
