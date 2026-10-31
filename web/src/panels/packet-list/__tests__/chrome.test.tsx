import { fireEvent, render, screen } from "@testing-library/react";
import type { ICellRendererParams } from "ag-grid-community";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  GridCell,
  GridPanelBody,
  GridStatusStrip,
  GridTextCell,
  windowStatus,
} from "../grid/chrome";

const SEARCH = { value: "", onChange: () => {}, onClear: () => {} };

const cellParams = (params: Partial<ICellRendererParams>) => params as ICellRendererParams;

describe("GridPanelBody", () => {
  it("renders the error state instead of the grid", () => {
    render(
      <GridPanelBody error="query exploded" search={SEARCH}>
        <div data-testid="grid" />
      </GridPanelBody>,
    );

    expect(screen.getByRole("alert").textContent).toBe("query exploded");
    expect(screen.queryByTestId("grid")).toBeNull();
    expect(screen.queryByPlaceholderText("Search...")).toBeNull();
  });

  it("renders the search and the grid, and no way back while there is nothing to return to", () => {
    render(
      <GridPanelBody error={null} search={SEARCH}>
        <div data-testid="grid" />
      </GridPanelBody>,
    );

    expect(screen.getByPlaceholderText("Search...")).toBeTruthy();
    expect(screen.getByTestId("grid")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Jump to/ })).toBeNull();
  });

  it("offers the way back while the panel is detached from the row it follows", () => {
    const onClick = vi.fn();
    render(
      <GridPanelBody error={null} search={SEARCH} follow={{ label: "Jump to latest", onClick }}>
        <div />
      </GridPanelBody>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Jump to latest/ }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("clears the search from its own button, shown only while there is text", () => {
    const onClear = vi.fn();
    const { rerender } = render(
      <GridPanelBody error={null} search={{ ...SEARCH, onClear }}>
        <div />
      </GridPanelBody>,
    );
    expect(screen.queryByLabelText("Clear search")).toBeNull();

    rerender(
      <GridPanelBody error={null} search={{ ...SEARCH, value: "dns", onClear }}>
        <div />
      </GridPanelBody>,
    );
    fireEvent.click(screen.getByLabelText("Clear search"));
    expect(onClear).toHaveBeenCalledOnce();
  });

  // Inside the panel Cmd+F is the panel's own search, so it must not also reach the host.
  it("claims Cmd+F for the panel's search and stops it there", () => {
    const outside = vi.fn();
    render(
      <div onKeyDown={outside}>
        <GridPanelBody error={null} search={SEARCH}>
          <div data-testid="grid" />
        </GridPanelBody>
      </div>,
    );

    const search = screen.getByPlaceholderText("Search...");
    expect(document.activeElement).not.toBe(search);

    fireEvent.keyDown(screen.getByTestId("grid"), { key: "f", metaKey: true });
    expect(document.activeElement).toBe(search);

    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(screen.getByTestId("grid"), { key: "F", ctrlKey: true });
    expect(document.activeElement).toBe(search);
    expect(outside).not.toHaveBeenCalled();
  });

  it("leaves every other chord alone: Cmd+Shift+F, Cmd+Alt+F and a bare f", () => {
    const outside = vi.fn();
    render(
      <div onKeyDown={outside}>
        <GridPanelBody error={null} search={SEARCH}>
          <div data-testid="grid" />
        </GridPanelBody>
      </div>,
    );

    fireEvent.keyDown(screen.getByTestId("grid"), { key: "f", metaKey: true, shiftKey: true });
    fireEvent.keyDown(screen.getByTestId("grid"), { key: "f", metaKey: true, altKey: true });
    fireEvent.keyDown(screen.getByTestId("grid"), { key: "f" });

    expect(document.activeElement).not.toBe(screen.getByPlaceholderText("Search..."));
    expect(outside).toHaveBeenCalledTimes(3);
  });
});

describe("GridCell", () => {
  const withSearch = (term: string, cell: ReactNode) =>
    render(
      <GridPanelBody error={null} search={{ ...SEARCH, value: term }}>
        {cell}
      </GridPanelBody>,
    );

  it("highlights the search terms inside a string cell", () => {
    const { container } = withSearch("tcp", <GridCell>TCP retransmission</GridCell>);

    expect([...container.querySelectorAll(".search-hit")].map((hit) => hit.textContent)).toEqual([
      "TCP",
    ]);
    expect(container.querySelector(".cell-text")?.textContent).toBe("TCP retransmission");
  });

  it("highlights each literal run of a glob, and not the wildcards", () => {
    const { container } = withSearch("*443*SYN*", <GridCell>51514 → 443 [SYN]</GridCell>);

    expect([...container.querySelectorAll(".search-hit")].map((hit) => hit.textContent)).toEqual([
      "443",
      "SYN",
    ]);
  });

  it("keeps a highlighted string one run of text, spaces and all", () => {
    const { container } = withSearch("port", <GridCell>dst port 53</GridCell>);

    const text = container.querySelector(".cell-text");
    expect(text?.querySelector(".search-hit")?.textContent).toBe("port");
    expect(text?.textContent).toBe("dst port 53");
  });

  it("renders the plain string when nothing is searched", () => {
    const { container } = withSearch("", <GridCell>TCP</GridCell>);

    expect(screen.getByText("TCP")).toBeTruthy();
    expect(container.querySelector(".search-hit")).toBeNull();
  });

  it("leaves a non-string child alone", () => {
    const { container } = withSearch(
      "tcp",
      <GridCell>
        <span data-testid="chip">TCP</span>
      </GridCell>,
    );

    expect(screen.getByTestId("chip")).toBeTruthy();
    expect(container.querySelector(".search-hit")).toBeNull();
  });

  // The grid suppresses cell focus, so the cell itself is what a keyboard reaches the menu through.
  it("stays reachable by keyboard", () => {
    withSearch("", <GridCell>TCP</GridCell>);

    const cell = screen.getByRole("button", { name: "TCP" });
    expect(cell.getAttribute("tabindex")).toBe("0");
    expect(cell.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("lights up the match in every cell of a matched row, whichever column it sits in", () => {
    const { container } = withSearch(
      "53",
      <>
        <GridTextCell {...cellParams({ data: { id: "r1" }, value: "10.0.0.5:5353" })} />
        <GridTextCell {...cellParams({ data: { id: "r1" }, value: "8.8.8.8:53" })} />
      </>,
    );

    expect([...container.querySelectorAll(".search-hit")].map((hit) => hit.textContent)).toEqual([
      "53",
      "53",
      "53",
    ]);
  });
});

describe("GridTextCell", () => {
  it("prefers the column's formatted text over the raw value", () => {
    render(
      <GridTextCell {...cellParams({ data: { id: "r1" }, value: 1, valueFormatted: "ICMP" })} />,
    );
    expect(screen.getByText("ICMP")).toBeTruthy();
  });

  it("renders a null value as empty, never as the string 'null'", () => {
    const { container } = render(
      <GridTextCell {...cellParams({ data: { id: "r1" }, value: null })} />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders nothing for a row the grid has not filled in", () => {
    const { container } = render(<GridTextCell {...cellParams({ data: undefined, value: "x" })} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("the status strip", () => {
  it("joins its parts with a dot, and renders nothing with nothing to say", () => {
    const { container, rerender } = render(
      <GridStatusStrip testId="strip" parts={["a", false, "b"]} />,
    );
    expect(screen.getByTestId("strip").textContent).toBe("a · b");

    rerender(<GridStatusStrip testId="strip" parts={[false, null]} />);
    expect(container.innerHTML).toBe("");
  });

  it("says how much of the window is on screen only when the buffer cut it", () => {
    expect(windowStatus(10_000, 10_000)).toBeNull();
    expect(windowStatus(10_000, 48_213)).toBe("window: newest 10,000 of 48,213 rows");
  });
});
