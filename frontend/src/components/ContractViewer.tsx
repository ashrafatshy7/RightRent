import { Minus, Plus, ScanLine, X } from "lucide-react";
import {
  getDocument,
  GlobalWorkerOptions,
  RenderingCancelledException,
  type PDFPageProxy,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { firstLocation, lineBoxesByPage, toScreenRect, type PdfBox } from "../lib/highlight-geometry";
import type { ClauseLocation, Severity } from "../types/api";

GlobalWorkerOptions.workerSrc = workerUrl;

export type ViewerHighlight = {
  clauseId: string;
  severity: Severity;
  severityLabel: string;
  label: string;
  title: string;
  locations: ClauseLocation[];
};

// A new object (even for the same clause) asks the viewer to scroll that clause into view.
export type FocusRequest = { clauseId: string; nonce: number };

type ContractViewerProps = {
  data: ArrayBuffer;
  highlights: ViewerHighlight[];
  selectedClauseId: string | null;
  focusRequest: FocusRequest | null;
  dimmedClauseIds: ReadonlySet<string>;
  linkedClauseIds?: ReadonlySet<string>;
  onSelect: (clauseId: string) => void;
  onClose?: () => void;
};

type PageInfo = { number: number; proxy: PDFPageProxy; width: number; height: number };
type PageHighlight = ViewerHighlight & { boxes: PdfBox[] };

const PAGE_GUTTER = 14;
const SCROLL_OFFSET = 72;
const TOOLTIP_WIDTH = 260;
const ZOOM_STEPS = [0.6, 0.8, 1, 1.25, 1.5, 2];
const NO_CLAUSES: ReadonlySet<string> = new Set();

function prefersReducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function ContractViewer({
  data,
  highlights,
  selectedClauseId,
  focusRequest,
  dimmedClauseIds,
  linkedClauseIds = NO_CLAUSES,
  onSelect,
  onClose,
}: ContractViewerProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRefs = useRef(new Map<number, HTMLDivElement>());
  const pendingScroll = useRef<string | null>(null);
  const [pages, setPages] = useState<PageInfo[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [zoomIndex, setZoomIndex] = useState(ZOOM_STEPS.indexOf(1));
  const [currentPage, setCurrentPage] = useState(1);
  const [hoveredClauseId, setHoveredClauseId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPages(null);
    setFailed(false);
    // pdf.js transfers the buffer to its worker, so it gets a copy and the cached response stays usable.
    const task = getDocument({ data: new Uint8Array(data.slice(0)), useSystemFonts: true });
    task.promise
      .then(async (document) => {
        const loaded: PageInfo[] = [];
        for (let number = 1; number <= document.numPages; number += 1) {
          const proxy = await document.getPage(number);
          const viewport = proxy.getViewport({ scale: 1 });
          loaded.push({ number, proxy, width: viewport.width, height: viewport.height });
        }
        if (!cancelled) setPages(loaded);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [data]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setAvailableWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const widestPage = pages ? Math.max(...pages.map((page) => page.width)) : 0;
  const fitScale = widestPage && availableWidth ? Math.max(0.3, (availableWidth - PAGE_GUTTER * 2) / widestPage) : 0;
  const scale = fitScale * ZOOM_STEPS[zoomIndex]!;

  const highlightsByPage = useMemo(() => {
    const byPage = new Map<number, PageHighlight[]>();
    for (const highlight of highlights) {
      for (const [page, boxes] of lineBoxesByPage(highlight.locations)) {
        const list = byPage.get(page) ?? [];
        list.push({ ...highlight, boxes });
        byPage.set(page, list);
      }
    }
    return byPage;
  }, [highlights]);

  const scrollToClause = useCallback((clauseId: string) => {
    const container = scrollRef.current;
    const location = firstLocation(highlights.find((item) => item.clauseId === clauseId)?.locations ?? []);
    const page = location ? pages?.[location.page - 1] : undefined;
    const pageElement = location ? pageRefs.current.get(location.page) : undefined;
    if (!container || !location || !page || !pageElement || !scale) {
      pendingScroll.current = clauseId;
      return;
    }
    pendingScroll.current = null;
    const rect = toScreenRect(location.bbox, page.proxy.getViewport({ scale }).transform);
    container.scrollTo({
      top: Math.max(0, pageElement.offsetTop + rect.top - SCROLL_OFFSET),
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [highlights, pages, scale]);

  const latestScrollToClause = useRef(scrollToClause);
  latestScrollToClause.current = scrollToClause;

  // Only a new request scrolls; zooming or re-rendering must not keep pulling the reader back.
  useEffect(() => {
    if (focusRequest) latestScrollToClause.current(focusRequest.clauseId);
  }, [focusRequest]);

  // A request made while the viewer could not lay pages out yet (still loading, or hidden behind
  // another tab or a closed sheet, where it has no width) is honoured once it can.
  useEffect(() => {
    if (pendingScroll.current) scrollToClause(pendingScroll.current);
  }, [scrollToClause]);

  function trackCurrentPage() {
    const container = scrollRef.current;
    if (!container || !pages) return;
    const probe = container.scrollTop + container.clientHeight / 3;
    let visible = 1;
    for (const page of pages) {
      const element = pageRefs.current.get(page.number);
      if (element && element.offsetTop <= probe) visible = page.number;
    }
    setCurrentPage(visible);
  }

  return (
    <div className="contract-viewer">
      <div className="viewer-toolbar">
        <span className="viewer-page-indicator">
          {pages ? `עמוד ${currentPage} מתוך ${pages.length}` : "טוענים את החוזה…"}
        </span>
        <div className="viewer-zoom" role="group" aria-label="זום">
          <button type="button" onClick={() => setZoomIndex((index) => Math.max(0, index - 1))} disabled={zoomIndex === 0} aria-label="הקטנה"><Minus size={15} /></button>
          <button type="button" className="viewer-fit" onClick={() => setZoomIndex(ZOOM_STEPS.indexOf(1))}>{Math.round(ZOOM_STEPS[zoomIndex]! * 100)}%</button>
          <button type="button" onClick={() => setZoomIndex((index) => Math.min(ZOOM_STEPS.length - 1, index + 1))} disabled={zoomIndex === ZOOM_STEPS.length - 1} aria-label="הגדלה"><Plus size={15} /></button>
        </div>
        {onClose ? <button type="button" className="viewer-close" onClick={onClose} aria-label="סגירת החוזה"><X size={18} /></button> : null}
      </div>
      <div ref={scrollRef} className="viewer-scroll" onScroll={trackCurrentPage}>
        {failed ? (
          <div className="viewer-message"><ScanLine size={22} /><p>לא הצלחנו להציג את החוזה המקורי. הממצאים עדיין זמינים ברשימה.</p></div>
        ) : null}
        {pages && scale ? pages.map((page) => (
          <PdfPage
            key={page.number}
            info={page}
            scale={scale}
            root={scrollRef.current}
            highlights={highlightsByPage.get(page.number) ?? []}
            selectedClauseId={selectedClauseId}
            hoveredClauseId={hoveredClauseId}
            dimmedClauseIds={dimmedClauseIds}
            linkedClauseIds={linkedClauseIds}
            onHover={setHoveredClauseId}
            onSelect={onSelect}
            register={(element) => {
              if (element) pageRefs.current.set(page.number, element);
              else pageRefs.current.delete(page.number);
            }}
          />
        )) : null}
      </div>
    </div>
  );
}

type PdfPageProps = {
  info: PageInfo;
  scale: number;
  root: HTMLDivElement | null;
  highlights: PageHighlight[];
  selectedClauseId: string | null;
  hoveredClauseId: string | null;
  dimmedClauseIds: ReadonlySet<string>;
  linkedClauseIds: ReadonlySet<string>;
  onHover: (clauseId: string | null) => void;
  onSelect: (clauseId: string) => void;
  register: (element: HTMLDivElement | null) => void;
};

function PdfPage({
  info,
  scale,
  root,
  highlights,
  selectedClauseId,
  hoveredClauseId,
  dimmedClauseIds,
  linkedClauseIds,
  onHover,
  onSelect,
  register,
}: PdfPageProps) {
  const pageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const viewport = useMemo(() => info.proxy.getViewport({ scale }), [info, scale]);

  // Pages are rendered only once they come near the visible area, so a long contract opens quickly.
  useEffect(() => {
    const element = pageRef.current;
    if (!element || nearViewport) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) setNearViewport(true);
    }, { root, rootMargin: "600px 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root, nearViewport]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!nearViewport || !canvas) return;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    const renderViewport = info.proxy.getViewport({ scale: scale * pixelRatio });
    canvas.width = Math.floor(renderViewport.width);
    canvas.height = Math.floor(renderViewport.height);
    const task = info.proxy.render({ canvas, viewport: renderViewport });
    task.promise.catch((error: unknown) => {
      if (!(error instanceof RenderingCancelledException)) console.error(error);
    });
    return () => task.cancel();
  }, [info, scale, nearViewport]);

  const hovered = highlights.find((highlight) => highlight.clauseId === hoveredClauseId);
  const hoveredRect = hovered?.boxes[0] ? toScreenRect(hovered.boxes[0], viewport.transform) : null;

  return (
    <div
      ref={(element) => {
        pageRef.current = element;
        register(element);
      }}
      className="pdf-page"
      style={{ width: viewport.width, height: viewport.height }}
      data-page={info.number}
    >
      <canvas ref={canvasRef} style={{ width: viewport.width, height: viewport.height }} aria-hidden="true" />
      {highlights.map((highlight) => {
        const state = [
          `severity-${highlight.severity.toLowerCase()}`,
          highlight.clauseId === selectedClauseId ? "selected" : "",
          highlight.clauseId === hoveredClauseId ? "hovered" : "",
          dimmedClauseIds.has(highlight.clauseId) ? "dimmed" : "",
          linkedClauseIds.has(highlight.clauseId) ? "linked" : "",
        ].filter(Boolean).join(" ");
        return highlight.boxes.map((box, index) => {
          const rect = toScreenRect(box, viewport.transform);
          // One focusable control per clause per page; the clause's other lines are visual only.
          const primary = index === 0;
          return (
            <button
              key={`${highlight.clauseId}-${index}`}
              type="button"
              className={`pdf-highlight ${state}`}
              style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
              tabIndex={primary ? 0 : -1}
              aria-hidden={primary ? undefined : true}
              aria-pressed={primary ? highlight.clauseId === selectedClauseId : undefined}
              aria-label={primary ? `${highlight.label}: ${highlight.title} — ${highlight.severityLabel}` : undefined}
              onClick={() => onSelect(highlight.clauseId)}
              onMouseEnter={() => onHover(highlight.clauseId)}
              onMouseLeave={() => onHover(null)}
              onFocus={() => onHover(highlight.clauseId)}
              onBlur={() => onHover(null)}
            />
          );
        });
      })}
      {hovered && hoveredRect ? (
        <div
          className={`pdf-tooltip severity-${hovered.severity.toLowerCase()} ${hoveredRect.top < 64 ? "below" : ""}`}
          role="tooltip"
          style={{
            right: viewport.width - Math.max(hoveredRect.left + hoveredRect.width, Math.min(TOOLTIP_WIDTH, viewport.width)),
            top: hoveredRect.top < 64 ? hoveredRect.top + hoveredRect.height + 6 : hoveredRect.top - 6,
          }}
        >
          <strong>{hovered.severityLabel} · {hovered.label}</strong>
          <span>{hovered.title}</span>
        </div>
      ) : null}
    </div>
  );
}
