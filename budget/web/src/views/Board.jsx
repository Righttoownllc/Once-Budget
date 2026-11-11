import { useEffect, useRef, useState } from 'preact/hooks';

/**
 * A board of cards you can move, resize, remove, add back, or set from a preset, laid out like
 * bricks (short cards fill in beside tall ones instead of leaving gaps). Used by the Budget
 * dashboard and Reports on wide screens. Each screen size keeps its own arrangement (localStorage,
 * per device).
 *
 * widgets: { type: { title, hint, fullHeight? } }
 * presets: { key: { name, build: cols => [item(type, width), ...] } }
 * defaultPreset: cls => preset key, for a size class ('desk' | 'fold')
 * render: item => the card for one widget
 */
export function useWidth() {
  const [w, setW] = useState(innerWidth);
  useEffect(() => { const f = () => setW(innerWidth); addEventListener('resize', f); return () => removeEventListener('resize', f); }, []);
  return w;
}
export const sizeClass = w => (w >= 1100 ? 'desk' : 'fold');
export const columnsFor = w => (w >= 1500 ? 4 : w >= 1100 ? 3 : 2);
/** One card on a board: a widget type and how many columns it spans. */
export const item = (type, width = 1) => ({ id: type + '-' + Math.random().toString(36).slice(2, 7), type, w: width });

export function Board({ storageKey, widgets, presets, defaultPreset, render, onLayout, emptyHint = 'Nothing here. Tap ✎ Customize, then a layout or + Add.' }) {
  const width = useWidth();
  const cls = sizeClass(width), cols = columnsFor(width);
  const key = storageKey + '.' + cls;
  const load = () => {
    try { const j = JSON.parse(localStorage.getItem(key) || 'null'); if (Array.isArray(j) && j.length) return j.filter(x => widgets[x.type]); } catch {}
    return presets[defaultPreset(cls)].build(cols);
  };
  const save = l => { try { localStorage.setItem(key, JSON.stringify(l)); } catch {} };
  const [list, setList] = useState(load);
  const [edit, setEdit] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => { setList(load()); }, [cls]);
  useEffect(() => { onLayout && onLayout(list); }, [list]);
  const update = l => { setList(l); save(l); };

  // Brick packing: the grid has 4 px rows, and each card spans as many as its height needs.
  const gridRef = useRef(null);
  useEffect(() => {
    const g = gridRef.current; if (!g) return;
    const fit = () => {
      const ws = [...g.querySelectorAll(':scope > .widget')];
      const spans = ws.map(el => Math.ceil((el.querySelector(':scope > .wbody')?.offsetHeight ?? 0) / 4) + 4 + (el.querySelector(':scope > .wbar')?.offsetHeight ? Math.ceil(el.querySelector(':scope > .wbar').offsetHeight / 4) + 2 : 0));
      const tallest = Math.max(0, ...spans);
      ws.forEach((el, i) => { el.style.gridRowEnd = 'span ' + (el.dataset.full ? Math.max(spans[i], tallest) : spans[i]); });
    };
    const ro = new ResizeObserver(fit);
    g.querySelectorAll(':scope > .widget .wbody').forEach(b => ro.observe(b));
    fit();
    return () => ro.disconnect();
  }, [list, edit, cols]);

  // Drag to move (pointer events: a finger or a mouse). Hovering another card moves the dragged one there.
  const drag = useRef(null);
  const onHandleDown = (e, id) => { e.preventDefault(); drag.current = id; e.target.setPointerCapture?.(e.pointerId); };
  const onHandleMove = e => {
    if (!drag.current) return;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-wid]')?.dataset.wid;
    if (!over || over === drag.current) return;
    setList(l => { const from = l.findIndex(x => x.id === drag.current), to = l.findIndex(x => x.id === over); if (from < 0 || to < 0) return l; const n = [...l]; const [it] = n.splice(from, 1); n.splice(to, 0, it); return n; });
  };
  const onHandleUp = () => { if (drag.current) { drag.current = null; setList(l => { save(l); return l; }); } };

  const missing = Object.keys(widgets).filter(t => !list.some(x => x.type === t));
  return (
    <div class={'dash' + (edit ? ' editing' : '')} style={`--cols:${cols}`}>
      <div class="dashbar">
        {edit ? (
          <>
            <span class="eyebrow">Layout</span>
            {Object.entries(presets).map(([k, p]) => <button class="chip" onClick={() => update(p.build(cols))}>{p.name}</button>)}
            <button class="chip" onClick={() => setAdding(a => !a)}>+ Add{missing.length ? ` (${missing.length} hidden)` : ''}</button>
            <button class="primary" style="margin-left:auto" onClick={() => { setEdit(false); setAdding(false); }}>Done</button>
          </>
        ) : <button class="ghost dashedit" onClick={() => setEdit(true)}>✎ Customize</button>}
      </div>
      {edit && adding && (
        <div class="card dashadd">
          {Object.entries(widgets).map(([t, d]) => (
            <button class="pick" onClick={() => { update([...list, item(t, d.wide ? cols : 1)]); setAdding(false); }}><b>{d.title}{list.some(x => x.type === t) ? ' (shown)' : ''}</b><span class="head">{d.hint}</span></button>
          ))}
        </div>
      )}
      <div class="dashgrid" ref={gridRef} onPointerMove={onHandleMove} onPointerUp={onHandleUp} onPointerCancel={onHandleUp}>
        {list.map(x => (
          <section class={'widget wt-' + x.type} key={x.id} data-wid={x.id} data-full={widgets[x.type].fullHeight ? '1' : undefined} style={`grid-column:span ${Math.min(x.w, cols)}`}>
            {edit && (
              <div class="wbar">
                <span class="whandle" onPointerDown={e => onHandleDown(e, x.id)} title="Drag to move">⠿ {widgets[x.type].title}</span>
                <span class="row" style="gap:4px">
                  <button class="ghost" title="Narrower" disabled={x.w <= 1} onClick={() => update(list.map(y => y.id === x.id ? { ...y, w: y.w - 1 } : y))}>−</button>
                  <button class="ghost" title="Wider" disabled={x.w >= cols} onClick={() => update(list.map(y => y.id === x.id ? { ...y, w: y.w + 1 } : y))}>+</button>
                  <button class="ghost" title="Remove" onClick={() => update(list.filter(y => y.id !== x.id))}>✕</button>
                </span>
              </div>
            )}
            <div class="wbody">{render(x)}</div>
          </section>
        ))}
        {!list.length && <div class="card head">{emptyHint}</div>}
      </div>
    </div>
  );
}
