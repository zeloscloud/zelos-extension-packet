import { useCallback, useMemo, useState } from "react";
import { type DissectNode, dissectFrame, findNodeAtOffset } from "./dissect";
import { type ByteRange, FrameHexView } from "./frame-hex-view";
import { parseFrameHex } from "./hex-bytes";

/**
 * The frame, two ways: the header tree and the bytes it addresses.
 *
 * Selection is two-way and lives here, as ONE byte range — clicking a tree node highlights its bytes, and
 * clicking a byte selects the deepest node containing it. A node is identified by its range rather than an
 * id: the range is what both views already agree on.
 */

function DissectRow({
  node,
  depth,
  selection,
  onSelect,
}: {
  node: DissectNode;
  depth: number;
  selection: ByteRange | null;
  onSelect: (range: ByteRange) => void;
}) {
  const isSelected = selection !== null && selection.offset === node.offset && selection.len === node.len;
  return (
    <>
      <button
        type="button"
        data-testid="dissect-node"
        className={isSelected ? "dissect-row selected" : "dissect-row"}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
        onClick={() => onSelect({ offset: node.offset, len: node.len })}
      >
        <span data-testid="dissect-label" className="dissect-label">
          {node.label}
        </span>
        <span data-testid="dissect-value" className="dissect-value">
          {node.value}
        </span>
      </button>
      {node.children?.map((child) => (
        <DissectRow
          key={`${child.label}:${child.offset}:${child.len}`}
          node={child}
          depth={depth + 1}
          selection={selection}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

interface PacketDissectViewProps {
  /** The `frame` cell, hex-encoded the way the query layer returns binary columns. */
  hex: string;
  /** The packet's own `link_type` (a libpcap DLT number) — never assumed. */
  linkType: number | null;
  truncated?: boolean | undefined;
  capLen?: number | undefined;
  origLen?: number | undefined;
}

export function PacketDissectView({ hex, linkType, truncated, capLen, origLen }: PacketDissectViewProps) {
  const [selection, setSelection] = useState<ByteRange | null>(null);
  const nodes = useMemo(() => dissectFrame(parseFrameHex(hex), linkType), [hex, linkType]);

  const onSelectByte = useCallback(
    (offset: number) => {
      const node = findNodeAtOffset(nodes, offset);
      setSelection(node ? { offset: node.offset, len: node.len } : null);
    },
    [nodes],
  );

  return (
    <div className="dissect-view">
      {nodes.length > 0 && (
        <div data-testid="packet-dissect-tree" className="dissect-tree">
          {nodes.map((node) => (
            <DissectRow
              key={`${node.label}:${node.offset}:${node.len}`}
              node={node}
              depth={0}
              selection={selection}
              onSelect={setSelection}
            />
          ))}
        </div>
      )}
      <FrameHexView
        hex={hex}
        truncated={truncated}
        capLen={capLen}
        origLen={origLen}
        selection={selection}
        onSelectByte={onSelectByte}
      />
    </div>
  );
}
