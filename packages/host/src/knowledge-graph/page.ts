/**
 * The standalone visual editor served at `/.dsh-agi/knowledge-graph`.
 *
 * It is one self-contained document: no framework, no external asset, so it works from
 * the plugin's authenticated web port and from the local development server. The
 * first screen is deliberately empty; the full graph is never drawn up front.
 */

/** Raw HTML/CSS/JS for the editor. */
export const KNOWLEDGE_GRAPH_PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>经验库图谱</title>
<style>
  :root {
    --bg: #0b0f14;
    --panel: #121820;
    --panel2: #18212c;
    --line: #2a3543;
    --line2: #3a4a5e;
    --text: #e6edf3;
    --muted: #8b98a8;
    --accent: #2dd4bf;
    --accent2: #14b8a6;
    --warn: #f59e0b;
    --danger: #f87171;
    --ok: #34d399;
    --shadow: 0 18px 50px rgba(0, 0, 0, .45);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.55 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    display: flex; flex-direction: column; overflow: hidden;
  }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  input, textarea, select {
    font: inherit; color: var(--text); background: #0d131a; border: 1px solid var(--line);
    border-radius: 8px; padding: 7px 9px; outline: none;
  }
  input:focus, textarea:focus, select:focus { border-color: var(--accent2); }
  .btn {
    background: var(--panel2); border: 1px solid var(--line); border-radius: 8px;
    padding: 7px 12px; white-space: nowrap;
  }
  .btn:hover { border-color: var(--line2); background: #1d2834; }
  .btn.primary { background: var(--accent2); border-color: var(--accent2); color: #03201c; font-weight: 600; }
  .btn.primary:hover { background: var(--accent); }
  .btn.ghost { background: transparent; }
  .btn.danger { color: var(--danger); border-color: #5a2a2a; }
  .btn.small { padding: 3px 8px; font-size: 12px; }
  .btn.pulse { animation: pulse 1.2s ease-in-out infinite; border-color: var(--accent); color: var(--accent); }
  @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(45, 212, 191, .45); } 50% { box-shadow: 0 0 0 7px rgba(45, 212, 191, 0); } }

  #topbar {
    height: 66px; flex: 0 0 66px; display: flex; align-items: center; gap: 18px;
    padding: 0 18px; background: #0e141b; border-bottom: 1px solid var(--line);
  }
  .brand { display: flex; align-items: center; gap: 11px; min-width: 230px; }
  .logo {
    width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center;
    background: linear-gradient(145deg, #123f3a, #0b2422); color: var(--accent);
    border: 1px solid #1f5c55; font-size: 20px;
  }
  .brand .title { font-weight: 700; letter-spacing: .04em; }
  .brand .sub { color: var(--muted); font-size: 11px; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #searchForm { flex: 1; display: flex; gap: 8px; max-width: 720px; }
  #searchInput { flex: 1; padding: 10px 13px; background: #0b1118; }
  .topActions { display: flex; gap: 8px; margin-left: auto; }

  #crumbs {
    flex: 0 0 42px; display: flex; align-items: center; gap: 8px; padding: 0 18px;
    border-bottom: 1px solid var(--line); background: #0c1218; color: var(--muted);
    font-size: 12px; overflow: hidden;
  }
  #crumbs .label { color: var(--accent); letter-spacing: .08em; }
  #crumbList { display: flex; align-items: center; gap: 5px; overflow-x: auto; white-space: nowrap; min-width: 0; }
  .crumb { border: 1px solid var(--line); background: #121a23; color: var(--text); border-radius: 999px; padding: 3px 10px; font-size: 12px; }
  .crumb.current { border-color: var(--accent2); color: var(--accent); }
  #returnBtn { margin-left: auto; flex: 0 0 auto; }
  #returnBtn:not(:disabled) { border-color: var(--accent2); color: var(--accent); background: #0c1b1a; font-weight: 600; }
  #backBtn { flex: 0 0 auto; }
  .dirtyFlag { border: 1px solid #7a5a16; background: rgba(245, 158, 11, .12); color: #fbbf24; border-radius: 999px; padding: 2px 10px; font-size: 11.5px; white-space: nowrap; }

  main { flex: 1; display: flex; min-height: 0; }
  #side {
    width: 292px; flex: 0 0 292px; background: var(--panel); border-right: 1px solid var(--line);
    display: flex; flex-direction: column; min-height: 0;
  }
  .tabs { display: flex; border-bottom: 1px solid var(--line); }
  .tabs button { flex: 1; background: transparent; border: 0; border-bottom: 2px solid transparent; padding: 11px 6px; color: var(--muted); }
  .tabs button.active { color: var(--text); border-bottom-color: var(--accent2); }
  .tabpane { padding: 14px; overflow: auto; flex: 1; min-height: 0; }
  .sectionTitle { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 12px; letter-spacing: .06em; margin: 16px 0 8px; }
  .sectionTitle:first-child { margin-top: 0; }
  .sectionTitle .grow { flex: 1; }
  .legend { display: grid; gap: 7px; margin: 10px 0 14px; color: var(--muted); font-size: 12px; }
  .legend span { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 7px; vertical-align: -1px; }
  .legend .a { background: var(--accent2); }
  .legend .p { background: #3b82f6; }
  .legend .c { background: #a78bfa; }
  .legend .s { background: #64748b; }
  .hintBox { border: 1px dashed var(--line2); border-radius: 10px; padding: 11px; color: var(--muted); font-size: 12px; }
  .field { display: grid; gap: 5px; margin-bottom: 9px; }
  .field label { color: var(--muted); font-size: 12px; }
  .row { display: flex; gap: 6px; align-items: center; }
  .row > * { min-width: 0; }
  .grow { flex: 1; }

  #stage { flex: 1; position: relative; min-width: 0; background: radial-gradient(circle at 50% 42%, #101a23 0%, #0b0f14 62%); overflow: hidden; }
  #graph { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
  #emptyHint {
    position: absolute; left: 50%; top: 47%; transform: translate(-50%, -50%);
    text-align: center; color: var(--muted); pointer-events: none;
  }
  #emptyHint .big { font-size: 34px; color: #30445a; margin-bottom: 10px; }
  #emptyHint h2 { color: var(--text); font-weight: 600; margin: 0 0 7px; }
  #emptyHint p { margin: 0; font-size: 13px; }

  #searchPanel {
    position: absolute; left: 18px; top: 18px; width: min(880px, calc(100% - 36px));
    max-height: calc(100% - 36px); overflow: auto; background: rgba(16, 23, 31, .98);
    border: 1px solid var(--line2); border-radius: 14px; box-shadow: var(--shadow); padding: 15px;
  }
  .searchHead { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: nowrap; }
  .searchHead h3 { margin: 0; font-size: 14px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .searchHeadActions { display: flex; gap: 8px; flex: 0 0 auto; }
  .searchNote { color: var(--muted); font-size: 11px; line-height: 1.6; margin: 0 0 12px; }
  .resultColumns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; }
  .resultCol { min-width: 0; }
  .colHead { display: flex; flex-direction: column; gap: 1px; padding: 0 2px 7px; margin-bottom: 9px; border-bottom: 1px solid var(--line); }
  .colHead b { font-size: 13px; }
  .colHead span { font-size: 11px; color: var(--muted); }
  .colEmpty { border: 1px dashed var(--line); border-radius: 10px; padding: 14px 10px; text-align: center; color: var(--muted); font-size: 12px; }
  .subHead { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; margin: 2px 0 7px; color: var(--muted); font-size: 11.5px; }
  .subHead b { font-size: 12px; color: var(--text); }
  .subHead.unmetHead b { color: var(--warn); }
  .cand { border: 1px solid var(--line); border-radius: 11px; padding: 10px; margin-bottom: 9px; background: #0e151d; min-width: 0; }
  .cand:hover { border-color: var(--line2); }
  .cand.selected { border-color: var(--accent2); background: #0c191b; box-shadow: inset 0 0 0 1px rgba(45, 212, 191, .35); }
  .cand h4 { margin: 0 0 3px; font-size: 13.5px; overflow-wrap: anywhere; }
  .sim { float: right; color: var(--accent); font-variant-numeric: tabular-nums; font-size: 12px; }
  .simbar { height: 3px; background: #23303d; border-radius: 3px; overflow: hidden; margin: 7px 0; }
  .simbar i { display: block; height: 100%; background: linear-gradient(90deg, #0f766e, var(--accent)); }
  .diff { color: #c7d2de; font-size: 12px; margin: 6px 0; }
  .diff b { color: var(--warn); font-weight: 600; }
  .descPair { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin: 7px 0; }
  .descPair div { background: #0a1016; border: 1px solid var(--line); border-radius: 8px; padding: 7px; font-size: 11px; color: var(--muted); max-height: 96px; overflow: auto; }
  .descPair b { display: block; color: #b8c5d3; font-weight: 600; margin-bottom: 3px; }
  .candActions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .emptyResult { text-align: center; padding: 8px 0 2px; }
  .emptyResult h3 { margin: 4px 0 5px; }
  .emptyResult p { color: var(--muted); font-size: 12px; margin: 0 0 11px; }
  .emptyResult .newCta { padding: 11px 18px; font-size: 15px; }
  .resultBlock { margin-bottom: 14px; }
  .blockHead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin: 0 0 7px; }
  .blockHead b { font-size: 13px; }
  .blockHead span { font-size: 11px; }
  .emptyLine { font-size: 11px; padding: 7px 9px; border: 1px dashed var(--line); border-radius: 9px; }
  .badges { display: flex; flex-wrap: wrap; gap: 5px; margin: 3px 0 5px; }
  .badge { display: inline-block; font-size: 10.5px; line-height: 1.5; padding: 0 6px; border-radius: 999px; border: 1px solid var(--line2); color: var(--muted); }
  .badge.simBadge { border-color: #1f6f66; color: var(--accent); }
  .badge.kwBadge { border-color: #7a5a16; color: var(--warn); }
  .badge.unmetBadge { border-color: #7a5a16; color: var(--warn); background: rgba(245, 158, 11, .1); }
  .cand.unmet { border-style: dashed; border-color: #5a4520; background: #0c1117; opacity: .78; }
  .cand.unmet:hover { opacity: .95; border-color: #8a6524; }
  .cand.unmet h4 { color: #d5dde6; font-weight: 500; }
  .cand.unmet .sim { color: var(--warn); }
  .cand.unmet .simbar i { background: linear-gradient(90deg, #7c5a12, var(--warn)); }
  .unmetNote { border: 1px dashed #6a4a12; background: rgba(245, 158, 11, .06); color: #f0c674; border-radius: 9px; padding: 7px 9px; font-size: 11.5px; margin: 8px 0; }
  .blockHead.unmetHead b { color: var(--warn); }
  .kwsim { float: right; color: var(--warn); font-variant-numeric: tabular-nums; font-size: 12px; }
  .hitLine { font-size: 11.5px; color: #c7d2de; margin: 5px 0 6px; word-break: break-word; }
  .hitLine mark { background: #4a3a05; color: #fde68a; border-radius: 3px; padding: 0 2px; }
  .muted { color: var(--muted); }
  .mono { font-family: "Cascadia Code", Consolas, monospace; }
  .tag { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; font-size: 11px; color: var(--muted); }
  .tag.ok { color: var(--ok); border-color: #245a44; }
  .tag.bad { color: var(--danger); border-color: #5a2a2a; }
  .tag.warn { color: var(--warn); border-color: #5a4520; }

  #dragHint {
    position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
    padding: 7px 13px; border-radius: 999px; background: #101922; border: 1px solid var(--line2);
    font-size: 12px; box-shadow: var(--shadow); pointer-events: none; max-width: 80%;
  }
  #dragHint.ok { color: var(--ok); border-color: #245a44; }
  #dragHint.bad { color: var(--danger); border-color: #6a2c2c; }
  #toast {
    position: fixed; right: 22px; bottom: 22px; z-index: 60; max-width: 420px;
    background: #13202a; border: 1px solid var(--line2); border-left: 3px solid var(--accent2);
    border-radius: 9px; padding: 10px 13px; box-shadow: var(--shadow); font-size: 13px;
  }
  #toast.bad { border-left-color: var(--danger); }
  #toast.warn { border-left-color: var(--warn); }

  .consoleNote { border: 1px solid #6a4a12; background: rgba(245, 158, 11, .08); color: #f0c674; border-radius: 9px; padding: 8px 10px; font-size: 11.5px; line-height: 1.55; margin-bottom: 10px; }
  .consoleHint { color: #d3a94a; font-size: 11px; line-height: 1.5; margin: 7px 0 0; }
  .tag.unsaved { color: #fbbf24; border-color: #7a5a16; background: rgba(245, 158, 11, .12); }

  #guardRoot { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; background: rgba(3, 7, 10, .72); padding: 24px; }
  #guardRoot[hidden] { display: none; }
  #guardCard { width: min(480px, 94vw); background: #0f161e; border: 1px solid var(--line2); border-radius: 14px; box-shadow: var(--shadow); }
  #guardHead { padding: 15px 16px 0; font-size: 15px; font-weight: 600; }
  #guardBody { padding: 9px 16px 15px; color: var(--muted); font-size: 12.5px; line-height: 1.65; }
  #guardBody b { color: var(--text); }
  #guardFoot { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; border-top: 1px solid var(--line); }

  #detail {
    position: fixed; top: 66px; right: 0; bottom: 0;
    width: var(--drawer-width, 33vw); min-width: 340px; max-width: min(640px, 92vw); z-index: 30;
    background: #0f161e; border-left: 1px solid var(--line2); box-shadow: -18px 0 45px rgba(0,0,0,.4);
    overflow: auto; padding: 16px;
  }
  #detail.drawer { width: var(--drawer-width, 33vw); }
  #detailResize {
    position: absolute; left: 0; top: 0; bottom: 0; width: 10px; cursor: col-resize;
    touch-action: none; z-index: 2;
  }
  #detailResize::after {
    content: ""; position: absolute; left: 3px; top: 50%; width: 3px; height: 46px;
    transform: translateY(-50%); border-radius: 2px; background: var(--line2);
  }
  #detailResize:hover::after, #detailResize.active::after { background: var(--accent2); }
  #detail h2 { margin: 0 0 3px; font-size: 17px; }
  #detail .meta { color: var(--muted); font-size: 11px; margin-bottom: 12px; word-break: break-all; }
  #detail .block { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 12px; }
  #detail .block h3 { margin: 0 0 8px; font-size: 12px; color: var(--muted); letter-spacing: .06em; }
  .shots { display: grid; gap: 10px; }
  .shot { border: 1px solid var(--line); border-radius: 9px; overflow: hidden; background: #0a1016; }
  .shot img { width: 100%; display: block; max-height: 230px; object-fit: contain; background: #05080b; }
  .shot figcaption { padding: 7px 8px; font-size: 12px; color: #c3ceda; display: flex; gap: 6px; align-items: center; }
  .edgeRow { display: flex; align-items: center; gap: 6px; padding: 5px 0; border-bottom: 1px dashed #1e2936; font-size: 12px; }
  .edgeRow .grow { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actionGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
  .actionGrid .wide { grid-column: span 2; }

  #modalRoot { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; background: rgba(3, 7, 10, .7); padding: 24px; }
  #modalRoot[hidden] { display: none; }
  #modal {
    width: min(880px, 96vw); max-height: 88vh; display: flex; flex-direction: column;
    background: #0f161e; border: 1px solid var(--line2); border-radius: 14px; box-shadow: var(--shadow);
  }
  #modalHead { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--line); }
  #modalHead h2 { margin: 0; font-size: 16px; flex: 1; }
  #modalBody { padding: 16px; overflow: auto; }
  #modalFoot { padding: 12px 16px; border-top: 1px solid var(--line); display: flex; gap: 8px; justify-content: flex-end; }
  .statGrid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; margin-bottom: 15px; }
  .stat { background: #0b1118; border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
  .stat b { display: block; font-size: 22px; font-variant-numeric: tabular-nums; }
  .stat span { color: var(--muted); font-size: 11px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 7px; border-bottom: 1px solid #1c2834; vertical-align: top; }
  th { color: var(--muted); font-weight: 500; }
  .pathRow { border: 1px solid var(--line); border-radius: 10px; padding: 9px; margin-bottom: 8px; background: #0c131a; }
  .pathRow h4 { margin: 0 0 3px; font-size: 13px; }
  .pathRow p { margin: 3px 0; color: var(--muted); font-size: 11px; }
  .steps { display: grid; gap: 7px; margin: 10px 0; }
  .step { display: flex; gap: 9px; align-items: flex-start; border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px; background: #0b1118; }
  .step.current { border-color: var(--accent2); background: #0c1b1a; }
  .step.met { border-color: #245a44; opacity: .82; }
  .step.unmet { border-color: #6a2c2c; background: #1a0e0e; }
  .step.skipped { opacity: .55; }
  .stepIcon { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: #1a2531; font-size: 12px; flex: 0 0 22px; }
  .step .body { flex: 1; min-width: 0; }
  .step .body b { font-size: 13px; }
  .step .body p { margin: 2px 0; color: var(--muted); font-size: 11px; }
  .runMsg { border: 1px solid var(--line2); border-left: 3px solid var(--accent2); border-radius: 9px; padding: 10px 12px; background: #0b151d; margin-bottom: 12px; font-size: 12px; }
  .runMsg.blocked { border-left-color: var(--danger); }
  .runMsg.complete { border-left-color: var(--ok); }
  .runActions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
  .blocker { border: 1px solid #5a2a2a; background: #180f0f; border-radius: 9px; padding: 9px; margin: 8px 0; font-size: 12px; }
  .blocker .row { margin-top: 6px; flex-wrap: wrap; }
  #modalBody pre { white-space: pre-wrap; word-break: break-word; background: #080d12; border: 1px solid var(--line); border-radius: 9px; padding: 10px; font-size: 12px; max-height: 320px; overflow: auto; }

  svg text { user-select: none; }
  .node { cursor: pointer; }
  .node rect.card { fill: #16212c; stroke: #3c4d60; stroke-width: 1.2; }
  .node.anchor rect.card { fill: #0e2f2c; stroke: var(--accent); stroke-width: 2; }
  .node.parent rect.card { stroke: #3b82f6; }
  .node.child rect.card { stroke: #a78bfa; }
  .node.sibling rect.card { stroke: #64748b; }
  .node.parent, .node.child, .node.sibling { opacity: .62; }
  .node.parent:hover, .node.child:hover, .node.sibling:hover { opacity: .95; }
  .node text.title { fill: #e6edf3; font-size: 13px; font-weight: 600; }
  .node text.role { fill: #8b98a8; font-size: 10px; letter-spacing: .05em; }
  .node .detailBtn { fill: #0d141b; stroke: #35465a; }
  .node text.detailText { fill: #8b98a8; font-size: 10px; }
  .node .handle { fill: #0f1c22; stroke: var(--accent2); stroke-width: 1.4; }
  .node .handleText { fill: var(--accent); font-size: 12px; font-weight: 700; }
  .edge { stroke: #3f5368; stroke-width: 1.6; fill: none; marker-end: url(#arrow); }
  .edge.hot { stroke: var(--accent); stroke-width: 2.2; }
  #dragLine { stroke: var(--warn); stroke-width: 2; stroke-dasharray: 5 4; pointer-events: none; }
  #dragLine.ok { stroke: var(--ok); }
  #dragLine.bad { stroke: var(--danger); }
  .target-ok rect.card { stroke: var(--ok) !important; stroke-width: 2.6 !important; }
  .target-bad rect.card { stroke: var(--danger) !important; stroke-width: 2.6 !important; }

  @media (max-width: 900px) {
    .resultColumns { grid-template-columns: minmax(0, 1fr); }
    #searchPanel { left: 12px; top: 12px; width: calc(100% - 24px); }
  }

  @media (max-width: 980px) {
    #side { display: none; }
    #topbar { gap: 9px; padding: 0 10px; }
    .brand { min-width: 0; }
    .brand .sub { display: none; }
    #detail, #detail.drawer { width: min(420px, 96vw); top: 108px; }
    .statGrid { grid-template-columns: repeat(2, 1fr); }
  }

  /* Narrow screens: the graph keeps the full width; the drawer overlays it from the
     right and can be dismissed, instead of squeezing the canvas. */
  @media (max-width: 1100px) {
    #detail, #detail.drawer {
      width: min(420px, 94vw); min-width: 300px;
      background: #0f161e; box-shadow: -24px 0 60px rgba(0, 0, 0, .62);
    }
    #detailResize { display: none; }
  }

  .relRow { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; flex-wrap: wrap; }
  .relLabel { color: var(--muted); font-size: 12px; width: 42px; flex: 0 0 auto; }
  .relPick { flex: 1; min-width: 0; border: 1px dashed var(--line2); border-radius: 8px; padding: 6px 9px; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .relPick.set { border-style: solid; border-color: #245a44; color: var(--text); }
  .relChoice { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text); margin-right: 12px; }
  .relResults { display: grid; gap: 7px; max-height: 260px; overflow: auto; margin-top: 9px; }
  .relResult { text-align: left; border: 1px solid var(--line); background: #0d141b; border-radius: 9px; padding: 8px 10px; }
  .relResult:hover { border-color: var(--line2); background: #121b24; }
  .relResult b { font-size: 13px; }
  .relResult .muted { font-size: 11px; }
  .relCheck { border: 1px solid var(--line2); border-radius: 9px; padding: 9px 11px; font-size: 12.5px; margin-top: 11px; }
  .relCheck.ok { border-color: #245a44; background: rgba(52, 211, 153, .08); color: var(--ok); }
  .relCheck.bad { border-color: #6a2c2c; background: rgba(248, 113, 113, .08); color: var(--danger); }
  .deletedRow { display: flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 9px; padding: 7px 9px; margin-bottom: 7px; background: #0d141b; }
  .deletedRow .grow { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .deletedRow .tag { flex: 0 0 auto; }
  #detail .block h3 .grow { flex: 1; }
</style>
</head>
<body>
<header id="topbar">
  <div class="brand">
    <div class="logo">◈</div>
    <div>
      <div class="title">经验库图谱</div>
      <div class="sub" id="libPath">有向无环图 · 路径收藏</div>
    </div>
  </div>
  <form id="searchForm" autocomplete="off">
    <input id="searchInput" placeholder="描述你要做的事，例如：给同事发福利积分" aria-label="搜索节点">
    <button class="btn" type="submit">搜索</button>
  </form>
  <div class="topActions">
    <span class="dirtyFlag" id="dirtyFlag" hidden>● 未保存</span>
    <button class="btn" data-action="open-relation">＋ 建立关系</button>
    <button class="btn" data-action="open-stats">统计看板</button>
    <button class="btn primary" id="newBtn" data-action="new-node">+ 新建节点</button>
  </div>
</header>
<div id="crumbs">
  <span class="label">路径栈</span>
  <div id="crumbList"><span class="muted">（空：点击一个节点开始）</span></div>
  <button class="btn small ghost" id="returnBtn" data-action="return-view" disabled>← 返回上一个视图</button>
  <button class="btn small ghost" id="backBtn" data-action="back-stack" disabled>← 回跳</button>
</div>
<main>
  <aside id="side">
    <div class="tabs">
      <button class="active" data-action="tab" data-tab="graph">图谱</button>
      <button data-action="tab" data-tab="index">收藏</button>
      <button data-action="tab" data-tab="log">操作记录</button>
    </div>
    <div class="tabpane" id="tab-graph">
      <div class="sectionTitle">锚点 <span class="grow"></span><button class="btn small ghost" data-action="clear-anchor">清空</button></div>
      <div class="hintBox" id="anchorInfo">搜索或新建一个节点后，它成为锚点；只显示 1 跳子图。</div>
      <div class="legend">
        <div><span class="a"></span>当前节点（实色）</div>
        <div><span class="p"></span>前置步骤（直接前置）</div>
        <div><span class="c"></span>后续步骤（直接后续）</div>
        <div><span class="s"></span>并列步骤（同一前置下的其他步骤）</div>
      </div>
      <div class="hintBox">
        拖节点右侧的 <b style="color:var(--accent)">+</b> 到另一个节点建边；拖拽时实时检测环与重复边，绿色可放、红色拒绝。<br><br>
        也可以直接<b style="color:var(--accent)">点击</b>节点右侧的 <b style="color:var(--accent)">+</b>：搜索目标节点、选「作为前置 / 后续」即可建边，不依赖画布上能看见它。<br><br>
        点击浅色节点切换锚点，路径栈会压入；回跳只动路径栈，不改变图上的高亮规则。
      </div>
      <div class="sectionTitle">节点状态 <span class="grow"></span>
        <button class="btn small" data-action="filter-active">在用</button>
        <button class="btn small" data-action="filter-deleted">已删除</button>
      </div>
      <div id="statusList" hidden></div>
      <div class="sectionTitle">当前锚点</div>
      <div id="anchorActions" class="actionGrid">
        <button class="btn small" data-action="detail-anchor" disabled>查看详情</button>
        <button class="btn small" data-action="copy-anchor" disabled>复制节点</button>
      </div>
    </div>
    <div class="tabpane" id="tab-index" hidden>
      <div class="sectionTitle">按需求检索收藏</div>
      <div class="field">
        <input id="indexQuery" placeholder="例如：给同事发福利积分">
      </div>
      <button class="btn primary" style="width:100%" data-action="match-index">检索收藏</button>
      <div id="indexResult" style="margin-top:12px"></div>
      <div class="sectionTitle">已保存的收藏 <span class="grow"></span><button class="btn small" data-action="save-path">保存当前路径为收藏</button></div>
      <div id="pathList"><span class="muted">还没有收藏。</span></div>
    </div>
    <div class="tabpane" id="tab-log" hidden>
      <div class="consoleNote">记录谁在什么时候新建 / 修改 / 复制 / 删除节点或连线、当时参考了哪些候选和相似度、最终选择是什么，用于事后追溯。</div>
      <div class="sectionTitle">最近操作记录</div>
      <div id="logList"><span class="muted">还没有操作记录。</span></div>
    </div>
  </aside>
  <section id="stage">
    <svg id="graph" viewBox="0 0 1200 760" preserveAspectRatio="xMidYMid meet">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#4b6076"></path>
        </marker>
      </defs>
      <g id="edgeLayer"></g>
      <g id="nodeLayer"></g>
      <line id="dragLine" x1="0" y1="0" x2="0" y2="0" hidden></line>
    </svg>
    <div id="emptyHint">
      <div class="big">◇</div>
      <h2>首屏是空图</h2>
      <p>搜索一个已有流程，或直接新建第一个节点。</p>
    </div>
    <div id="searchPanel" hidden></div>
    <div id="dragHint" hidden></div>
  </section>
  <div id="detail" class="drawer" hidden><div id="detailResize" title="拖动调整宽度"></div></div>
</main>
<div id="modalRoot" hidden>
  <div id="modal" role="dialog" aria-modal="true">
    <div id="modalHead"><h2 id="modalTitle"></h2><button class="btn small ghost" data-action="close-modal">关闭</button></div>
    <div id="modalBody"></div>
    <div id="modalFoot"></div>
  </div>
</div>
<div id="guardRoot" hidden>
  <div id="guardCard" role="dialog" aria-modal="true" aria-labelledby="guardHead">
    <div id="guardHead">有未保存的修改</div>
    <div id="guardBody"></div>
    <div id="guardFoot">
      <button class="btn ghost" id="guardCancelBtn" data-action="guard-cancel">取消</button>
      <button class="btn" id="guardDiscardBtn" data-action="guard-discard">放弃</button>
      <button class="btn primary" id="guardSaveBtn" data-action="guard-save">保存</button>
    </div>
  </div>
</div>
<div id="toast" hidden></div>
<script>
(function () {
  "use strict";
  var BASE = location.pathname.replace(/\/index\.html$/, "").replace(/\/+$/, "");
  var state = {
    settings: { searchThreshold: 0.75, semanticFloor: 0.3, topK: 5, confirmTop: 3, keywordTop: 20, keywordFloor: 0.2 },
    anchor: null,
    stack: [],
    graph: null,
    search: null,
    query: "",
    selectedCandidate: null,
    viewStack: [],
    mainView: null,
    guard: null,
    titles: {},
    stats: null,
    paths: [],
    detail: null,
    run: null,
    runNodes: {},
    currentTab: "graph",
    dragged: false,
    relation: null,
    deletedOpen: false
  };
  var svg = document.getElementById("graph");
  var edgeLayer = document.getElementById("edgeLayer");
  var nodeLayer = document.getElementById("nodeLayer");
  var dragLine = document.getElementById("dragLine");
  var toastTimer = null;
  var drag = null;
  var dragSeq = 0;
  var dragCheck = { ok: false, message: "" };

  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function pct(value) { return (Math.round((value || 0) * 1000) / 10).toFixed(1) + "%"; }
  function scoreOf(value) { return (Math.round((value || 0) * 100) / 100).toFixed(2); }
  function fieldLabel(field) {
    return field === "title" ? "标题" : field === "name" ? "收藏名" : field === "summary" ? "收藏摘要" : field === "screenshot" ? "截图说明" : "说明";
  }
  function statusLabel(status) {
    return status === "deleted" ? "已删除" : status === "active" ? "在用" : "历史状态";
  }
  function scoreBadges(scores) {
    if (!scores) return "";
    var html = "";
    if (scores.semantic != null) html += '<span class="badge simBadge">语义 ' + pct(scores.semantic) + '</span>';
    if (scores.keyword != null) html += '<span class="badge kwBadge">关键词 ' + scoreOf(scores.keyword) + '</span>';
    return html;
  }
  // Escape first, then wrap the escaped fragment; never inject raw node text.
  function markHit(snippet, fragment) {
    var safe = esc(snippet);
    var needle = esc(fragment || "");
    if (needle === "") return safe;
    var at = safe.indexOf(needle);
    if (at < 0) return safe;
    return safe.slice(0, at) + "<mark>" + needle + "</mark>" + safe.slice(at + needle.length);
  }
  function show(el, yes) { if (el) el.hidden = !yes; }
  function toast(message, kind) {
    var el = $("toast");
    el.textContent = message;
    el.className = kind === "bad" ? "bad" : kind === "warn" ? "warn" : "";
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4200);
  }
  function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || "GET", headers: {} };
    if (opts.body !== undefined) {
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }
    return fetch(BASE + path, init).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (err) { data = null; }
        if (!response.ok || data === null || data.ok === false) {
          var message = data && data.error && data.error.message ? data.error.message : ("请求失败（HTTP " + response.status + "）");
          var error = new Error(message);
          error.code = data && data.error ? data.error.code : "http-" + response.status;
          throw error;
        }
        return data;
      });
    });
  }

  function formatTs(ts) { return String(ts == null ? "" : ts).slice(0, 19).replace("T", " "); }
  function pctWhole(value) { return Math.round((value || 0) * 100) + "%"; }

  // ---------- unsaved guard ----------
  function isMainDirty() {
    var view = state.mainView;
    if (!view) return false;
    if (view.kind === "create") {
      var createTitle = $("createTitle");
      var createDesc = $("createDesc");
      if (!createTitle || !createDesc) return false;
      return createTitle.value.trim() !== "" || createDesc.value.trim() !== "";
    }
    if (view.kind !== "edit") return false;
    var title = $("detailTitle");
    var desc = $("detailDesc");
    if (!title || !desc) return false;
    return title.value !== view.base.title
      || desc.value !== view.base.description;
  }

  function refreshDirtyUI() {
    var dirty = isMainDirty();
    var flag = $("dirtyFlag");
    if (flag) flag.hidden = !dirty;
    var tag = $("detailDirtyTag");
    if (tag) tag.hidden = !(state.mainView && state.mainView.kind === "edit" && dirty);
  }

  function guardMainView(what) {
    if (!state.mainView || !isMainDirty()) return Promise.resolve(true);
    var label = state.mainView.kind === "create" ? "新建的节点还没有保存" : ("节点「" + state.mainView.title + "」的修改还没有保存");
    return askUnsaved(what, label);
  }

  function guardCreateModal(what) {
    if (!state.mainView || state.mainView.kind !== "create" || !isMainDirty()) return Promise.resolve(true);
    return askUnsaved(what, "新建的节点还没有保存");
  }

  function openGuard(mode, title, bodyHtml, confirmText, danger) {
    return new Promise(function (resolve) {
      state.guard = { mode: mode, resolve: resolve };
      $("guardHead").textContent = title;
      $("guardBody").innerHTML = bodyHtml;
      var save = $("guardSaveBtn");
      var discard = $("guardDiscardBtn");
      save.textContent = confirmText || "保存";
      save.className = danger ? "btn danger" : "btn primary";
      discard.hidden = mode !== "unsaved";
      $("guardRoot").hidden = false;
      setTimeout(function () { if (save) save.focus(); }, 0);
    });
  }

  function closeGuard(value) {
    var pending = state.guard;
    state.guard = null;
    $("guardRoot").hidden = true;
    if (pending) pending.resolve(value);
  }

  function askUnsaved(what, label) {
    return openGuard("unsaved", "有未保存的修改",
      '<p>' + esc(label || "当前编辑内容还没有保存") + '。</p>'
      + '<p>现在「' + esc(what) + '」会离开它：<b>保存</b>先写回知识库再继续，<b>放弃</b>丢掉草稿继续，<b>取消</b>留在当前视图。</p>');
  }

  function askConfirm(options) {
    return openGuard("confirm", options.title, options.body, options.confirmText || "确定", options.danger === true);
  }

  function hideDetail() {
    $("detail").hidden = true;
    state.detail = null;
    state.mainView = null;
    refreshDirtyUI();
  }

  function closeDetailGuarded() {
    if (state.guard) { closeGuard(false); return; }
    if (!state.mainView || state.mainView.kind !== "edit" || !isMainDirty()) { hideDetail(); return; }
    askUnsaved("关闭当前编辑").then(function (proceed) { if (proceed) hideDetail(); });
  }

  function closeModalGuarded() {
    if (state.guard) { closeGuard(false); return; }
    var wasCreate = state.mainView && state.mainView.kind === "create";
    var finishClose = function () {
      closeModal();
      if (wasCreate) {
        state.mainView = null;
        refreshDirtyUI();
      }
    };
    if (wasCreate && isMainDirty()) {
      askUnsaved("关闭新建节点窗口").then(function (proceed) { if (proceed) finishClose(); });
      return;
    }
    finishClose();
  }

  // ---------- modal ----------
  function showModal(title, bodyHtml) {
    $("modalTitle").textContent = title;
    $("modalBody").innerHTML = bodyHtml;
    $("modalFoot").innerHTML = "";
    $("modalRoot").hidden = false;
  }
  function closeModal() {
    $("modalRoot").hidden = true;
    $("modalBody").innerHTML = "";
    state.relation = null;
  }

  // ---------- breadcrumbs / view stack ----------
  function renderCrumbs() {
    var list = $("crumbList");
    $("returnBtn").disabled = state.viewStack.length === 0;
    if (state.stack.length === 0) {
      list.innerHTML = '<span class="muted">（空：点击一个节点开始）</span>';
      $("backBtn").disabled = true;
      return;
    }
    list.innerHTML = state.stack.map(function (id, index) {
      var current = index === state.stack.length - 1;
      return '<button class="crumb' + (current ? " current" : "") + '" data-action="crumb" data-index="' + index + '">' + esc(state.titles[id] || id) + '</button>';
    }).join('<span class="muted">›</span>');
    $("backBtn").disabled = state.stack.length <= 1;
  }

  function captureSearchState() {
    if (!state.search) return null;
    return {
      visible: !$("searchPanel").hidden,
      query: state.query,
      result: state.search,
      selectedId: state.selectedCandidate
    };
  }

  // Main view = the node being edited or the node being created. A temporary view is a
  // search result, an anchor jump or a peek at another node; leaving it restores the view
  // that was on screen before, including the search results and the selected candidate.
  function pushViewSnapshot() {
    state.viewStack.push({
      anchorId: state.anchor ? state.anchor.id : null,
      stack: state.stack.slice(),
      search: captureSearchState(),
      detailOpen: !$("detail").hidden
    });
    if (state.viewStack.length > 20) state.viewStack.shift();
    renderCrumbs();
  }

  function navigateTemp(id) {
    if (!id) return;
    pushViewSnapshot();
    show($("searchPanel"), false);
    goAnchor(id, true);
  }

  function returnView() {
    var snapshot = state.viewStack.pop();
    if (!snapshot) return;
    var finish = function () {
      if (snapshot.search && snapshot.search.result) {
        state.selectedCandidate = snapshot.search.selectedId || null;
        renderSearch(snapshot.search.result);
        show($("searchPanel"), snapshot.search.visible !== false);
      }
      renderCrumbs();
      refreshDirtyUI();
    };
    if (!snapshot.anchorId) {
      state.anchor = null;
      state.graph = null;
      state.stack = (snapshot.stack || []).slice();
      clearGraph();
      show($("emptyHint"), true);
      renderCrumbs();
      finish();
      return;
    }
    state.stack = (snapshot.stack || []).slice();
    state.anchor = null;
    goAnchor(snapshot.anchorId, false, true).then(finish).catch(finish);
  }

  // ---------- graph ----------
  function clearGraph() {
    edgeLayer.innerHTML = "";
    nodeLayer.innerHTML = "";
  }

  function nodePosition(entry, index, total, role) {
    if (role === "anchor") return { x: 600, y: 380 };
    if (role === "parent") return { x: 210, y: 380 + (index - (total - 1) / 2) * 108 };
    if (role === "child") return { x: 990, y: 380 + (index - (total - 1) / 2) * 108 };
    var columns = Math.max(1, Math.ceil(total / 2));
    var top = index < columns;
    var col = top ? index : index - columns;
    return { x: 600 + (col - (columns - 1) / 2) * 236, y: top ? 86 : 674 };
  }

  function edgePath(a, b) {
    var dx = b.x > a.x ? 110 : -110;
    return "M " + a.x + " " + a.y + " C " + (a.x + dx) + " " + a.y + ", " + (b.x - dx) + " " + b.y + ", " + b.x + " " + b.y;
  }

  function svgEl(name, attrs) {
    var el = document.createElementNS("http://www.w3.org/2000/svg", name);
    if (attrs) Object.keys(attrs).forEach(function (key) { el.setAttribute(key, attrs[key]); });
    return el;
  }

  function renderGraph() {
    clearGraph();
    var graph = state.graph;
    if (!graph) {
      show($("emptyHint"), true);
      return;
    }
    show($("emptyHint"), false);
    var byRole = { parent: [], child: [], sibling: [] };
    graph.nodes.forEach(function (entry) {
      if (entry.role !== "anchor") byRole[entry.role].push(entry);
    });
    var positions = {};
    graph.nodes.forEach(function (entry) {
      var group = entry.role === "anchor" ? [entry] : byRole[entry.role];
      var index = group.indexOf(entry);
      positions[entry.node.id] = nodePosition(entry, index, group.length, entry.role);
    });
    graph.edges.forEach(function (edge) {
      var a = positions[edge.from];
      var b = positions[edge.to];
      if (!a || !b) return;
      var path = svgEl("path", { d: edgePath(a, b), class: "edge" });
      path.setAttribute("data-edge", edge.from + "->" + edge.to);
      edgeLayer.appendChild(path);
    });
    graph.nodes.forEach(function (entry) {
      var pos = positions[entry.node.id];
      var roleClass = entry.role === "anchor" ? "anchor" : entry.role;
      var group = svgEl("g", { class: "node " + roleClass, "data-id": entry.node.id, transform: "translate(" + (pos.x - 100) + "," + (pos.y - 30) + ")" });
      var card = svgEl("rect", { class: "card", x: 0, y: 0, width: 200, height: 60, rx: 10 });
      group.appendChild(card);
      var title = entry.node.title.length > 19 ? entry.node.title.slice(0, 19) + "…" : entry.node.title;
      var text = svgEl("text", { class: "title", x: 12, y: 25 });
      text.textContent = title;
      group.appendChild(text);
      var role = svgEl("text", { class: "role", x: 12, y: 45 });
      role.textContent = entry.role === "anchor" ? "当前节点 · " + statusLabel(entry.node.status)
        : entry.role === "parent" ? "前置步骤 · 直接前置"
        : entry.role === "child" ? "后续步骤 · 直接后续"
        : "并列步骤 · 同一前置";
      group.appendChild(role);
      var detail = svgEl("rect", { class: "detailBtn", x: 146, y: 6, width: 46, height: 18, rx: 5 });
      detail.setAttribute("data-detail", entry.node.id);
      group.appendChild(detail);
      var detailText = svgEl("text", { class: "detailText", x: 156, y: 19 });
      detailText.setAttribute("data-detail", entry.node.id);
      detailText.textContent = "详情";
      group.appendChild(detailText);
      var handle = svgEl("circle", { class: "handle", cx: 200, cy: 30, r: 10, "data-handle": entry.node.id });
      group.appendChild(handle);
      var plus = svgEl("text", { class: "handleText", x: 195, y: 35, "data-handle": entry.node.id });
      plus.textContent = "+";
      var handleTip = svgEl("title", {});
      handleTip.textContent = "点击：搜索目标节点建边；拖动：直接连到画布上的节点";
      plus.appendChild(handleTip);
      group.appendChild(plus);
      var titleTip = svgEl("title", {});
      titleTip.textContent = entry.node.title + "\n" + entry.node.description;
      group.appendChild(titleTip);
      nodeLayer.appendChild(group);
    });
    $("anchorInfo").innerHTML = graph.isolated
      ? '<b>' + esc(graph.anchor.title) + '</b><br>还没有任何连线。点节点右侧 + 搜索目标节点建边，或拖 + 到画布上的节点。'
      : '<b>' + esc(graph.anchor.title) + '</b><br>前置步骤 ' + byRole.parent.length + ' · 后续步骤 ' + byRole.child.length + ' · 并列步骤 ' + byRole.sibling.length + '<br><span class="muted">图只显示 1 跳；点击浅色节点切换锚点，点击 + 搜索任意节点建边。</span>';
    state.titles[graph.anchor.id] = graph.anchor.title;
    graph.nodes.forEach(function (entry) { state.titles[entry.node.id] = entry.node.title; });
    var detailBtn = document.querySelector('[data-action="detail-anchor"]');
    var copyBtn = document.querySelector('[data-action="copy-anchor"]');
    if (detailBtn) detailBtn.disabled = false;
    if (copyBtn) copyBtn.disabled = false;
    renderCrumbs();
  }

  function goAnchor(id, push, force) {
    if (!id) return;
    if (state.anchor && state.anchor.id === id && push !== true && force !== true) return;
    if (push !== false) {
      if (state.stack[state.stack.length - 1] !== id) state.stack.push(id);
    }
    $("searchPanel").hidden = true;
    renderCrumbs();
    return api("/api/neighborhood?id=" + encodeURIComponent(id)).then(function (data) {
      state.anchor = data.anchor;
      state.graph = data;
      renderGraph();
      return data;
    }).catch(function (error) { toast(error.message, "bad"); });
  }

  // ---------- search ----------
  function isMet(candidate) { return candidate.meets_threshold !== false; }
  function splitSemantic(list) {
    var met = [];
    var unmet = [];
    (list || []).forEach(function (candidate) { if (isMet(candidate)) met.push(candidate); else unmet.push(candidate); });
    return { met: met, unmet: unmet };
  }
  function semanticCard(candidate, unmet) {
    var node = candidate.node;
    state.titles[node.id] = node.title;
    var selected = state.selectedCandidate === node.id ? " selected" : "";
    var html = '<div class="cand' + (unmet ? " unmet" : "") + selected + '" data-node="' + esc(node.id) + '">';
    html += '<span class="sim">' + pct(candidate.similarity) + '</span><h4>' + esc(node.title) + '</h4>';
    var badges = unmet ? '<span class="badge unmetBadge">未达阈值 · 最接近</span>' : '';
    if (candidate.scores) badges += scoreBadges(candidate.scores);
    if (badges !== "") html += '<div class="badges">' + badges + '</div>';
    html += '<div class="simbar"><i style="width:' + Math.max(3, Math.round(candidate.similarity * 100)) + '%"></i></div>';
    if (candidate.diff) {
      html += '<div class="diff"><b>差异：</b>' + esc(candidate.diff) + '</div>';
    } else {
      html += '<div class="muted" style="font-size:11px">模型差异不可用，并排显示：</div>';
      html += '<div class="descPair"><div><b>你的描述</b>' + esc(state.query) + '</div><div><b>节点说明</b>' + esc(node.description || '（空）') + '</div></div>';
    }
    html += '<div class="candActions">'
      + '<button class="btn small primary" data-action="reuse" data-id="' + esc(node.id) + '" data-sim="' + candidate.similarity + '">复用该节点</button>'
      + '<button class="btn small" data-action="variant" data-id="' + esc(node.id) + '">以它为起点新建</button>'
      + '<button class="btn small ghost" data-action="anchor" data-id="' + esc(node.id) + '">定位</button>'
      + '</div></div>';
    return html;
  }
  function searchHeadHtml(total) {
    return '<div class="searchHead"><h3>搜索结果 · 共 ' + total + ' 条</h3>'
      + '<div class="searchHeadActions">'
      + '<button class="btn small primary" data-action="new-node">+ 新建节点</button>'
      + '<button class="btn small ghost" data-action="close-search">关闭</button>'
      + '</div></div>';
  }

  function renderSearch(result) {
    var panel = $("searchPanel");
    panel.hidden = false;
    var semantic = result.candidates || [];
    var keyword = result.keyword || [];
    var floor = result.keyword_threshold == null ? 0.2 : result.keyword_threshold;
    var semanticFloor = result.semantic_floor == null ? 0.3 : result.semantic_floor;
    var groups = splitSemantic(semantic);
    var total = semantic.length + keyword.length;

    // The empty state appears only when both columns have nothing to show.
    if (total === 0) {
      $("newBtn").classList.add("pulse");
      panel.innerHTML = searchHeadHtml(0)
        + '<div class="emptyResult"><h3>没有可显示的节点</h3>'
        + '<p>语义匹配取前 3 条且要求相似度 ≥ 地板 ' + pct(semanticFloor) + '；关键词门槛 ' + scoreOf(floor)
        + (result.best_similarity == null ? '；图里还没有可搜索的节点。' : '；最高相似度 ' + pct(result.best_similarity) + '。')
        + '<br>直接新建一个节点，把这次经验记下来。</p>'
        + '<button class="btn primary newCta pulse" data-action="new-node">+ 新建节点</button></div>';
      return;
    }
    $("newBtn").classList.remove("pulse");

    var html = searchHeadHtml(total);
    html += '<div class="searchNote">左栏语义匹配：固定取前 3 条，相似度 ≥ ' + pct(result.threshold)
      + ' 为达标，' + pct(semanticFloor) + '～' + pct(result.threshold) + ' 标「未达阈值 · 最接近」仅供参考。'
      + '右栏关键词匹配：按字符逐字命中（不是正则），不受相似度阈值限制（门槛 ' + scoreOf(floor) + '）。</div>';
    html += '<div class="resultColumns">';

    // Left column: semantic TOP3, confirmed first and the nearest below-threshold after it.
    html += '<section class="resultCol" data-col="semantic"><div class="colHead"><b>语义匹配</b><span>语义 TOP3 · 达标 ' + groups.met.length + ' · 未达阈值 ' + groups.unmet.length + '</span></div>';
    if (semantic.length === 0) {
      html += '<div class="colEmpty">无命中<span style="display:block;font-size:11px;margin-top:3px">相似度都在地板 ' + pct(semanticFloor) + ' 以下</span></div>';
    } else {
      if (groups.met.length > 0) {
        html += '<div class="subHead"><b>达标（' + groups.met.length + '）</b><span>可以直接复用；差异由模型生成</span></div>';
        groups.met.forEach(function (candidate) { html += semanticCard(candidate, false); });
      }
      if (groups.unmet.length > 0) {
        html += '<div class="subHead unmetHead"><b>未达阈值 · 最接近（' + groups.unmet.length + '）</b><span>仅参考，不代表匹配</span></div>';
        html += '<div class="unmetNote">没有达到阈值，<b>不能当作已确认的匹配</b>；可以复用 / 以它为起点，或直接新建节点。</div>';
        groups.unmet.forEach(function (candidate) { html += semanticCard(candidate, true); });
      }
    }
    html += '</section>';

    // Right column: keyword channel, character matching only.
    html += '<section class="resultCol" data-col="keyword"><div class="colHead"><b>关键词匹配</b><span>按字符匹配（不是正则），不受阈值限制</span></div>';
    if (keyword.length === 0) {
      html += '<div class="colEmpty">无命中<span style="display:block;font-size:11px;margin-top:3px">没有达到 ' + scoreOf(floor) + ' 的字符命中</span></div>';
    }
    keyword.forEach(function (candidate) {
      var node = candidate.node;
      state.titles[node.id] = node.title;
      var sim = candidate.scores && candidate.scores.semantic != null ? candidate.scores.semantic : candidate.score;
      var selected = state.selectedCandidate === node.id ? " selected" : "";
      html += '<div class="cand' + selected + '" data-node="' + esc(node.id) + '">';
      html += '<span class="kwsim">' + scoreOf(candidate.score) + '</span><h4>' + esc(node.title) + '</h4>';
      html += '<div class="badges">' + scoreBadges(candidate.scores) + '</div>';
      html += '<div class="hitLine">命中' + fieldLabel(candidate.field) + '：' + markHit(candidate.snippet, candidate.fragment) + '</div>';
      html += '<div class="candActions">'
        + '<button class="btn small primary" data-action="reuse" data-id="' + esc(node.id) + '" data-sim="' + sim + '">复用该节点</button>'
        + '<button class="btn small" data-action="variant" data-id="' + esc(node.id) + '">以它为起点新建</button>'
        + '<button class="btn small ghost" data-action="anchor" data-id="' + esc(node.id) + '">定位</button>'
        + '</div></div>';
    });
    html += '</section></div>';
    panel.innerHTML = html;
  }

  function doSearch() {
    var query = $("searchInput").value.trim();
    if (query === "") { $("searchInput").focus(); return; }
    state.query = query;
    state.selectedCandidate = null;
    var panel = $("searchPanel");
    panel.hidden = false;
    panel.innerHTML = '<div class="searchHead"><h3>检索中…</h3></div><div class="muted">正在计算语义相似度与关键词命中，并请模型生成差异。</div>';
    api("/api/search?q=" + encodeURIComponent(query) + "&threshold=" + state.settings.searchThreshold).then(function (data) {
      state.search = data;
      renderSearch(data);
    }).catch(function (error) {
      panel.innerHTML = '<div class="searchHead"><h3>检索失败</h3><button class="btn small ghost" data-action="close-search">关闭</button></div><div class="muted">' + esc(error.message) + '</div>';
    });
  }

  // ---------- create / detail ----------
  function openCreate(prefill) {
    var data = prefill || {};
    var body = '<div class="field"><label>标题</label><input id="createTitle" value="' + esc(data.title || "") + '" placeholder="例如：给同事发福利积分"></div>'
      + '<div class="field"><label>说明（纯文字操作步骤，embedding 和模型都读它）</label><textarea id="createDesc" rows="6" placeholder="先做什么，再做什么，成功判据是什么">' + esc(data.description || "") + '</textarea></div>'
      + '<div class="field"><label>创建人</label><input id="createBy" value="human"></div>'
      + (data.derived_from ? '<div class="muted" style="font-size:11px">将记录 derived_from = ' + esc(data.derived_from) + '；不复制任何边。</div>' : '');
    showModal("新建节点 · 未保存", body);
    var foot = $("modalFoot");
    var cancel = document.createElement("button");
    cancel.className = "btn ghost";
    cancel.textContent = "取消";
    cancel.setAttribute("data-action", "close-modal");
    var save = document.createElement("button");
    save.className = "btn primary";
    save.textContent = "创建";
    save.setAttribute("data-action", "create-node");
    save.setAttribute("data-derived", data.derived_from || "");
    foot.appendChild(cancel);
    foot.appendChild(save);
    state.mainView = {
      kind: "create",
      derivedFrom: data.derived_from || null,
      base: { title: data.title || "", description: data.description || "" }
    };
    refreshDirtyUI();
    setTimeout(function () { var input = $("createTitle"); if (input) input.focus(); }, 0);
  }

  function createNodeFromModal(derived) {
    var title = $("createTitle");
    var desc = $("createDesc");
    var by = $("createBy");
    return api("/api/nodes", { method: "POST", body: {
      title: title ? title.value : "",
      description: desc ? desc.value : "",
      created_by: by && by.value !== "" ? by.value : "human",
      derived_from: derived || null
    } }).then(function (data) {
      $("newBtn").classList.remove("pulse");
      toast("节点已创建。也可以点「＋ 建立关系」搜索目标节点建边，或在收藏页保存路径。");
      return data;
    });
  }

  function saveDetailNode(id) {
    return api("/api/nodes/" + encodeURIComponent(id), { method: "PATCH", body: { title: $("detailTitle").value, description: $("detailDesc").value } }).then(function (data) {
      toast("已保存。");
      return openDetail(data.node.id);
    });
  }

  function saveMainView() {
    var view = state.mainView;
    if (!view || !isMainDirty()) return Promise.resolve(true);
    if (view.kind === "create") return createNodeFromModal(view.derivedFrom).then(function () { return true; });
    return saveDetailNode(view.id).then(function () { return true; });
  }

  function renderDetail(detail) {
    state.detail = detail;
    var node = detail.node;
    var deleted = node.status === "deleted";
    state.titles[node.id] = node.title;
    var drawer = $("detail");
    var html = '<div id="detailResize" title="拖动调整宽度"></div>';
    html += '<div class="row"><h2 class="grow">' + esc(node.title || "未命名节点") + '</h2><span class="tag unsaved" id="detailDirtyTag" hidden>未保存</span><button class="btn small ghost" data-action="close-detail">关闭</button></div>';
    html += '<div class="meta">' + esc(statusLabel(node.status)) + ' · 创建人 ' + esc(node.created_by) + ' · ' + esc(formatTs(node.created_at));
    if (node.derived_from) html += '<br>来源节点：<a href="#" data-action="anchor" data-id="' + esc(node.derived_from) + '">' + esc(state.titles[node.derived_from] || "查看来源节点") + '</a>';
    html += '</div>';
    html += '<div class="field"><label>标题</label><input id="detailTitle" value="' + esc(node.title) + '"></div>';
    html += '<div class="field"><label>说明</label><textarea id="detailDesc" rows="6">' + esc(node.description) + '</textarea></div>';
    html += '<div class="actionGrid"><button class="btn primary wide" data-action="save-node" data-id="' + esc(node.id) + '">保存修改</button></div>';

    html += '<div class="block"><h3>截图（校验参考图）</h3><div class="shots">';
    if (detail.screenshots.length === 0) html += '<span class="muted">还没有截图。</span>';
    detail.screenshots.forEach(function (shot) {
      html += '<figure class="shot"><img src="' + esc(BASE + "/" + shot.url) + '" alt="' + esc(shot.caption) + '" loading="lazy">'
        + '<figcaption><span class="grow">' + esc(shot.caption) + '</span><button class="btn small danger" data-action="delete-shot" data-id="' + esc(node.id) + '" data-shot="' + esc(shot.id) + '">删</button></figcaption></figure>';
    });
    html += '</div><div class="row" style="margin-top:8px"><input type="file" id="shotFile" accept="image/png,image/jpeg,image/webp,image/gif" style="flex:1"></div>'
      + '<div class="row" style="margin-top:6px"><input id="shotCaption" class="grow" placeholder="这句截图说明用来校验准确性"><button class="btn small" data-action="upload-shot" data-id="' + esc(node.id) + '">上传</button></div></div>';

    html += '<div class="block"><h3>入边（直接前置，全部必须满足）<span class="grow"></span><button class="btn small" data-action="relate-node" data-id="' + esc(node.id) + '" data-dir="before">+ 加前置</button></h3>';
    if (detail.incoming.length === 0) html += '<span class="muted">无入边：它可以作为流程起点。</span>';
    detail.incoming.forEach(function (edge) {
      html += '<div class="edgeRow"><span class="grow">' + esc(edge.from_title) + ' → 本节点</span><button class="btn small danger" data-action="delete-edge" data-from="' + esc(edge.from) + '" data-to="' + esc(edge.to) + '">删</button></div>';
    });
    html += '</div><div class="block"><h3>出边（直接后续）<span class="grow"></span><button class="btn small" data-action="relate-node" data-id="' + esc(node.id) + '" data-dir="after">+ 加后续</button></h3>';
    if (detail.outgoing.length === 0) html += '<span class="muted">无出边：它可以作为流程终点。</span>';
    detail.outgoing.forEach(function (edge) {
      html += '<div class="edgeRow"><span class="grow">本节点 → ' + esc(edge.to_title) + '</span><button class="btn small danger" data-action="delete-edge" data-from="' + esc(edge.from) + '" data-to="' + esc(edge.to) + '">删</button></div>';
    });
    html += '</div>';
    html += '<div class="block"><h3>被这些收藏引用</h3>';
    if (detail.paths.length === 0) html += '<span class="muted">没有收藏引用它。</span>';
    detail.paths.forEach(function (path) {
      html += '<div class="edgeRow"><span class="grow">' + esc(path.name) + ' <span class="tag ' + (path.runnable ? "ok" : "bad") + '">' + (path.runnable ? "可执行" : "有缺陷") + '</span></span><button class="btn small" data-action="view-path" data-id="' + esc(path.id) + '">查看</button></div>';
    });
    html += '</div>';
    html += '<div class="block"><h3>节点操作</h3><div class="actionGrid">'
      + '<button class="btn wide" data-action="copy-node" data-id="' + esc(node.id) + '">复制节点（内容复制，连线需自己重建）</button>';
    if (deleted) {
      html += '<button class="btn primary wide" data-action="restore-node" data-id="' + esc(node.id) + '">恢复节点</button>';
    } else {
      html += '<button class="btn danger wide" data-action="delete-node" data-id="' + esc(node.id) + '">删除</button>';
    }
    html += '</div><div class="muted" style="font-size:11px;margin-top:7px">复制只复制标题、说明和截图（内容复制，连线需自己重建）；删除是软删除，可从「已删除」筛选里恢复。</div></div>';
    drawer.innerHTML = html;
    drawer.hidden = false;
    bindDrawerResize();
    state.mainView = {
      kind: "edit",
      id: node.id,
      title: node.title,
      base: {
        title: node.title,
        description: node.description
      }
    };
    refreshDirtyUI();
  }

  function openDetail(id) {
    return api("/api/nodes/" + encodeURIComponent(id)).then(function (detail) {
      renderDetail(detail);
      return detail;
    }).catch(function (error) { toast(error.message, "bad"); });
  }

  // ---------- index / paths ----------
  function renderPaths(rows) {
    state.paths = rows;
    var html = "";
    if (rows.length === 0) html = '<span class="muted">还没有收藏。先用锚点走出路径栈，再点「保存当前路径为收藏」。</span>';
    rows.forEach(function (path) {
      html += '<div class="pathRow"><h4>' + esc(path.name) + ' <span class="tag ' + (path.runnable ? "ok" : "bad") + '">' + (path.runnable ? "可执行" : "有缺陷") + '</span></h4>';
      html += '<p>' + esc(path.summary) + '</p>';
      html += '<p>' + esc(path.node_titles.join(' → ')) + '</p>';
      if (!path.runnable) html += '<p style="color:var(--danger)">' + esc(path.problems.join('；')) + '</p>';
      html += '<div class="row" style="margin-top:6px"><button class="btn small primary" data-action="run-path" data-id="' + esc(path.id) + '">测试</button>'
        + '<button class="btn small" data-action="view-path" data-id="' + esc(path.id) + '">查看完整路径</button>'
        + '<button class="btn small danger" data-action="delete-path" data-id="' + esc(path.id) + '">删</button></div>'
        + '<p class="consoleHint">这里是知识库管理台，不是操作台；测试会真实操作电脑，请谨慎。</p></div>';
    });
    $("pathList").innerHTML = html;
  }

  function loadPaths() {
    return api("/api/paths").then(function (data) {
      renderPaths(data.paths);
      return data.paths;
    }).catch(function (error) { toast(error.message, "bad"); });
  }

  function pathCard(candidate, unmet) {
    // auto_executable is false both below the threshold and when the saved sequence no
    // longer validates; either way a human has to confirm before the path may be tested.
    var manual = candidate.auto_executable === false;
    var html = '<div class="cand' + (unmet ? " unmet" : "") + '">';
    html += '<span class="sim">' + pct(candidate.similarity) + '</span><h4>' + esc(candidate.path.name) + '</h4>';
    var badges = unmet ? '<span class="badge unmetBadge">未达阈值 · 最接近</span>' : '';
    if (candidate.scores) badges += scoreBadges(candidate.scores);
    if (badges !== "") html += '<div class="badges">' + badges + '</div>';
    html += '<div class="diff">' + esc(candidate.path.summary) + '</div>';
    html += '<div class="muted" style="font-size:11px">' + esc(candidate.node_titles.join(' → ')) + '</div>';
    html += '<div class="muted" style="font-size:11px">' + (candidate.runnable ? '可执行' : '有缺陷，需先修') + '</div>';
    if (manual) {
      html += '<div class="unmetNote">' + (unmet ? '相似度低于阈值' : '路径当前没有通过校验') + '，<b>不会自动执行</b>；只能由你点下面的按钮人工确认测试。</div>';
      html += '<div class="candActions"><button class="btn small" data-action="run-path" data-force="1" data-id="' + esc(candidate.path.id) + '">人工确认测试</button>'
        + '<button class="btn small" data-action="view-path" data-force="1" data-id="' + esc(candidate.path.id) + '">查看路径</button></div></div>';
    } else {
      html += '<div class="candActions"><button class="btn small primary" data-action="run-path" data-id="' + esc(candidate.path.id) + '">确认并测试</button>'
        + '<button class="btn small" data-action="view-path" data-id="' + esc(candidate.path.id) + '">查看路径</button></div></div>';
    }
    return html;
  }
  function matchIndex() {
    var query = $("indexQuery").value.trim();
    var box = $("indexResult");
    if (query === "") { $("indexQuery").focus(); return; }
    box.innerHTML = '<span class="muted">匹配中…</span>';
    api("/api/index/match?q=" + encodeURIComponent(query) + "&threshold=" + state.settings.searchThreshold).then(function (data) {
      var semantic = data.candidates || [];
      var keyword = data.keyword || [];
      var floor = data.keyword_threshold == null ? 0.2 : data.keyword_threshold;
      var semanticFloor = data.semantic_floor == null ? 0.3 : data.semantic_floor;
      var groups = splitSemantic(semantic);
      if (semantic.length === 0 && keyword.length === 0) {
        box.innerHTML = '<div class="blocker"><b>没有匹配的收藏，已停机。</b><br>' + esc(data.message || "请补充信息。")
          + '<div class="row" style="margin-top:8px"><button class="btn small" data-action="new-node">+ 新建节点</button></div></div>';
        return;
      }
      var html = '<div class="muted" style="font-size:11px;margin-bottom:9px">语义前 ' + semantic.length + ' 个（达标 ' + groups.met.length + '，阈值 ' + pct(data.threshold) + '，地板 ' + pct(semanticFloor) + '）+ 关键词命中 ' + keyword.length + ' 个（门槛 ' + scoreOf(floor) + '）。同一个收藏在达标组与关键词组之间只显示一条；低于阈值的收藏<b>不会自动执行</b>。</div>';
      html += '<div class="resultBlock"><div class="blockHead"><b>语义达标（' + groups.met.length + '）</b><span class="muted">相似度 ≥ ' + pct(data.threshold) + '，可以直接确认测试</span></div>';
      if (groups.met.length === 0) html += '<div class="muted emptyLine">没有超过 ' + pct(data.threshold) + ' 的收藏。</div>';
      groups.met.forEach(function (candidate) { html += pathCard(candidate, false); });
      html += '</div>';
      if (groups.unmet.length > 0) {
        html += '<div class="resultBlock"><div class="blockHead unmetHead"><b>未达阈值 · 最接近（' + groups.unmet.length + '）</b><span class="muted">相似度 ' + pct(semanticFloor) + '～' + pct(data.threshold) + '；仅供人确认，不自动执行</span></div>';
        html += '<div class="unmetNote">这些收藏没有达到阈值，<b>低于阈值的路径不允许自动执行</b>，只能由人显式点击确认。<button class="btn small" style="margin-left:8px" data-action="new-node">+ 新建节点</button></div>';
        groups.unmet.forEach(function (candidate) { html += pathCard(candidate, true); });
        html += '</div>';
      }
      html += '<div class="resultBlock"><div class="blockHead"><b>关键词匹配（' + keyword.length + '）</b><span class="muted">收藏名与摘要的字符级命中</span></div>';
      if (keyword.length === 0) html += '<div class="muted emptyLine">没有达到 ' + scoreOf(floor) + ' 的关键词命中。</div>';
      keyword.forEach(function (candidate) {
        html += '<div class="cand"><span class="kwsim">' + scoreOf(candidate.score) + '</span><h4>' + esc(candidate.path.name) + '</h4>';
        if (candidate.scores) html += '<div class="badges">' + scoreBadges(candidate.scores) + '</div>';
        html += '<div class="hitLine">命中' + fieldLabel(candidate.field) + '：' + markHit(candidate.snippet, candidate.fragment) + '</div>';
        html += '<div class="muted" style="font-size:11px">' + esc(candidate.node_titles.join(' → ')) + '</div>';
        html += '<div class="muted" style="font-size:11px">' + (candidate.runnable ? '可执行' : '有缺陷，需先修') + '；需要人工确认后才会测试</div>';
        html += '<div class="candActions"><button class="btn small" data-action="run-path" data-force="1" data-id="' + esc(candidate.path.id) + '">人工确认测试</button>'
          + '<button class="btn small" data-action="view-path" data-id="' + esc(candidate.path.id) + '">查看路径</button></div></div>';
      });
      html += '</div>';
      box.innerHTML = html;
    }).catch(function (error) { box.innerHTML = '<div class="blocker">' + esc(error.message) + '</div>'; });
  }

  function viewPath(id, force) {
    api("/api/paths/" + encodeURIComponent(id)).then(function (detail) {
      var problems = detail.problems.length === 0 ? '<span class="tag ok">当前可执行</span>' : '<span class="tag bad">' + esc(detail.problems.map(function (p) { return p.message; }).join('；')) + '</span>';
      var html = problems + '<pre>' + esc(detail.text) + '</pre>';
      showModal("收藏：" + detail.path.name, html);
      var foot = $("modalFoot");
      var run = document.createElement("button");
      run.className = "btn primary";
      run.textContent = "开始测试";
      run.setAttribute("data-action", "run-path");
      run.setAttribute("data-id", id);
      if (force) run.setAttribute("data-force", "1");
      foot.appendChild(run);
    }).catch(function (error) { toast(error.message, "bad"); });
  }

  function savePathFromStack() {
    if (state.stack.length === 0) { toast("路径栈是空的：先点击节点走出路径。", "warn"); return; }
    var body = '<div class="field"><label>收藏名（只给人看）</label><input id="pathName" placeholder="例如：发福利积分"></div>'
      + '<div class="field"><label>收藏摘要（检索时读它）</label><textarea id="pathSummary" rows="3" placeholder="一句话说明这条路径解决什么问题、对象和前置"></textarea></div>'
      + '<div class="field"><label>完整路径（来自路径栈）</label><div class="hintBox">' + esc(state.stack.join(' → ')) + '</div></div>';
    showModal("保存为收藏", body);
    var foot = $("modalFoot");
    var save = document.createElement("button");
    save.className = "btn primary";
    save.textContent = "保存收藏";
    save.setAttribute("data-action", "create-path");
    foot.appendChild(save);
  }

  function renderRun(view) {
    state.run = view;
    var html = '<div class="runMsg ' + (view.complete ? "complete" : view.blocked ? "blocked" : "") + '">' + esc(view.message) + '</div>';
    html += '<div class="steps">';
    view.steps.forEach(function (step) {
      var icon = step.status === "met" ? "✓" : step.status === "unmet" ? "✕" : step.status === "skipped" ? "↷" : "•";
      var node = state.runNodes[step.node_id];
      html += '<div class="step ' + step.status + (view.current_node_id === step.node_id ? " current" : "") + '">'
        + '<div class="stepIcon">' + icon + '</div><div class="body"><b>' + esc(step.title) + '</b>'
        + (node && node.description ? '<p>' + esc(node.description) + '</p>' : '')
        + (step.reason ? '<p>判定：' + esc(step.reason) + '</p>' : '')
        + '<p class="muted">' + esc(step.status) + '</p></div></div>';
    });
    html += '</div>';
    if (!view.complete) {
      html += '<div class="field"><label>当前屏幕 / 操作结果（给模型判定用）</label><textarea id="runEvidence" rows="2" placeholder="例如：页面顶部出现绿色对勾「发送关爱成功~」"></textarea></div>';
      var current = view.steps.filter(function (step) { return step.node_id === view.current_node_id; })[0];
      if (current && view.ready) {
        html += '<div class="runActions">'
          + '<button class="btn primary" data-action="judge-met" data-id="' + esc(current.node_id) + '">判定达标</button>'
          + '<button class="btn danger" data-action="judge-unmet" data-id="' + esc(current.node_id) + '">判定未达标</button>'
          + '<button class="btn" data-action="judge-llm" data-id="' + esc(current.node_id) + '">让 LLM 判定</button>'
          + '<button class="btn ghost" data-action="skip-step" data-id="' + esc(current.node_id) + '">标记跳过</button>'
          + '</div>';
      }
      if (current && current.status === "unmet") {
        html += '<div class="runActions"><button class="btn" data-action="reset-step" data-id="' + esc(current.node_id) + '">补执行该步</button>'
          + '<button class="btn ghost" data-action="skip-step" data-id="' + esc(current.node_id) + '">标记跳过</button></div>';
      }
      view.blockers.forEach(function (blocker) {
        html += '<div class="blocker"><b>阻塞：</b>' + esc(blocker.message) + '<div class="row">';
        blocker.missing.forEach(function (missing) {
          html += '<button class="btn small" data-action="reset-step" data-id="' + esc(missing.node_id) + '">补执行 ' + esc(missing.title) + '</button>'
            + '<button class="btn small ghost" data-action="skip-step" data-id="' + esc(missing.node_id) + '">标记 ' + esc(missing.title) + ' 跳过</button>';
        });
        if (blocker.node_id !== view.current_node_id) {
          html += '<button class="btn small" data-action="open-node" data-id="' + esc(blocker.node_id) + '">查看 ' + esc(blocker.title) + ' 的入边</button>';
        }
        html += '</div></div>';
      });
      if (view.current_node_id) {
        html += '<div class="runActions"><button class="btn small ghost" data-action="open-node" data-id="' + esc(view.current_node_id) + '">修改当前节点的入边</button></div>';
      }
    }
    showModal("测试收藏：" + view.path_name, html);
  }

  function testPath(id, manual) {
    var body = '<p>' + (manual
      ? '<b>这条收藏没有达到自动执行的条件</b>（未达阈值或路径未通过校验），系统不会自动执行，只能由你人工确认后测试。'
      : '确认要测试这条收藏吗？') + '</p>'
      + '<p>测试会<b>真实操作电脑</b>：打开页面、点击、输入都会真实发生。</p>'
      + '<p>这里是知识库管理台，不是操作台；请先确认当前屏幕可以交给它操作，并保留随时接管的能力。</p>';
    askConfirm({
      title: manual ? "人工确认测试这条收藏？" : "测试这条收藏？",
      body: body,
      confirmText: manual ? "人工确认并测试" : "开始测试",
      danger: manual
    }).then(function (ok) {
      if (!ok) return;
      closeModal();
      startRun(id);
    });
  }

  function startRun(pathId) {
    api("/api/paths/" + encodeURIComponent(pathId)).then(function (detail) {
      state.runNodes = {};
      detail.nodes.forEach(function (node) { state.runNodes[node.id] = node; });
      return api("/api/paths/" + encodeURIComponent(pathId) + "/run", { method: "POST", body: {} });
    }).then(function (data) {
      renderRun(data.view);
    }).catch(function (error) { toast(error.message, "bad"); });
  }

  function runAction(action, id) {
    if (!state.run) return;
    var runId = state.run.id;
    var evidence = $("runEvidence") ? $("runEvidence").value.trim() : "";
    var request;
    if (action === "judge-met" || action === "judge-unmet") {
      request = api("/api/runs/" + encodeURIComponent(runId) + "/judge", { method: "POST", body: { node_id: id, verdict: action === "judge-met" ? "met" : "unmet", reason: evidence || (action === "judge-met" ? "人工确认达标" : "人工确认未达标") } });
    } else if (action === "judge-llm") {
      request = api("/api/runs/" + encodeURIComponent(runId) + "/judge-llm", { method: "POST", body: { node_id: id, evidence: evidence } });
    } else if (action === "skip-step") {
      request = api("/api/runs/" + encodeURIComponent(runId) + "/skip", { method: "POST", body: { node_id: id, reason: evidence || "人工标记跳过" } });
    } else if (action === "reset-step") {
      request = api("/api/runs/" + encodeURIComponent(runId) + "/reset", { method: "POST", body: { node_id: id } });
    } else {
      return;
    }
    request.then(function (data) { renderRun(data.view); }).catch(function (error) { toast(error.message, "bad"); });
  }

  // ---------- stats ----------
  function renderStats(stats, operations) {
    state.stats = stats;
    var counts = stats.counts;
    var legacy = (counts.merged || 0) + (counts.deprecated || 0);
    var html = '<div class="statGrid">'
      + '<div class="stat"><b>' + counts.nodes + '</b><span>节点（在用 ' + counts.active + ' / 已删除 ' + counts.deleted + (legacy > 0 ? ' · 历史状态 ' + legacy : '') + '）</span></div>'
      + '<div class="stat"><b>' + counts.edges + '</b><span>有向边</span></div>'
      + '<div class="stat"><b>' + counts.paths + '</b><span>收藏路径（可执行 ' + counts.runnable_paths + '）</span></div>'
      + '<div class="stat"><b>' + counts.decisions + '</b><span>操作记录</span></div></div>';
    html += '<div class="row" style="margin-bottom:14px;flex-wrap:wrap"><span class="muted">搜索阈值</span><input id="thresholdInput" type="number" min="0" max="1" step="0.01" value="' + stats.settings.searchThreshold + '" style="width:90px">'
      + '<span class="muted">语义地板</span><input id="floorInput" type="number" min="0" max="1" step="0.01" value="' + (stats.settings.semanticFloor == null ? 0.3 : stats.settings.semanticFloor) + '" style="width:90px">'
      + '<button class="btn small" data-action="save-settings">保存</button><span class="muted" style="font-size:11px">默认阈值 0.75、地板 0.30；语义通道固定取前 3 条，低于地板的不出现；关键词通道取前 ' + stats.settings.keywordTop + ' 个、门槛 ' + scoreOf(stats.settings.keywordFloor) + '。改一项不会重置另一项。</span></div>';
    html += '<div class="sectionTitle">节点度数</div><table><thead><tr><th>节点</th><th>状态</th><th>入</th><th>出</th></tr></thead><tbody>';
    stats.nodes.slice(0, 30).forEach(function (node) {
      html += '<tr><td><a href="#" data-action="anchor" data-id="' + esc(node.id) + '">' + esc(node.title || "未命名节点") + '</a></td><td>' + esc(statusLabel(node.status)) + '</td><td>' + node.in_degree + '</td><td>' + node.out_degree + '</td></tr>';
    });
    html += '</tbody></table>';
    html += '<div class="sectionTitle">收藏路径</div>';
    stats.paths.forEach(function (path) {
      html += '<div class="pathRow"><h4>' + esc(path.name) + ' <span class="tag ' + (path.runnable ? "ok" : "bad") + '">' + (path.runnable ? "可执行" : "有缺陷") + '</span></h4><p>' + esc(path.node_titles.join(' → ')) + '</p></div>';
    });
    html += '<div class="sectionTitle">最近操作</div><table><thead><tr><th>时间</th><th>操作</th><th>节点</th><th>说明</th></tr></thead><tbody>';
    operations.forEach(function (row) {
      html += '<tr><td class="mono">' + esc(formatTs(row.ts)) + '</td><td>' + esc(row.action_label) + '</td><td>' + esc(row.node_title) + '</td><td>' + esc(row.diff_summary) + '</td></tr>';
    });
    html += '</tbody></table>';
    showModal("统计看板", html);
  }

  function openStats() {
    Promise.all([api("/api/stats"), api("/api/log?limit=20")]).then(function (data) {
      state.settings = data[0].stats.settings;
      renderStats(data[0].stats, data[1].entries);
    }).catch(function (error) { toast(error.message, "bad"); });
  }

  // ---------- drag edges ----------
  function svgPoint(event) {
    var point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    var matrix = svg.getScreenCTM();
    if (!matrix) return { x: 0, y: 0 };
    return point.matrixTransform(matrix.inverse());
  }

  function setDragHint(text, kind) {
    var hint = $("dragHint");
    hint.textContent = text;
    hint.className = kind || "";
    hint.hidden = false;
  }

  function clearDragVisual() {
    dragLine.hidden = true;
    dragLine.setAttribute("class", "");
    var nodes = nodeLayer.querySelectorAll("g.node");
    for (var i = 0; i < nodes.length; i += 1) nodes[i].classList.remove("target-ok", "target-bad");
    $("dragHint").hidden = true;
  }

  function beginDrag(event) {
    var handle = event.target.closest ? event.target.closest("[data-handle]") : null;
    if (!handle) return;
    event.preventDefault();
    event.stopPropagation();
    var from = handle.getAttribute("data-handle");
    var point = svgPoint(event);
    // A press on the + is either a drag (build the edge by hand) or a click (open the
    // search dialog). The line only appears once the pointer actually moves.
    drag = { from: from, to: null, valid: false, message: "", moved: false, clientX: event.clientX, clientY: event.clientY, x: point.x, y: point.y };
    dragCheck = { ok: false, message: "" };
    dragLine.setAttribute("x1", point.x);
    dragLine.setAttribute("y1", point.y);
    dragLine.setAttribute("x2", point.x);
    dragLine.setAttribute("y2", point.y);
    dragLine.hidden = true;
    $("dragHint").hidden = true;
    if (svg.setPointerCapture) { try { svg.setPointerCapture(event.pointerId); } catch (err) {} }
  }

  function moveDrag(event) {
    if (!drag) return;
    if (!drag.moved) {
      if (Math.abs(event.clientX - drag.clientX) + Math.abs(event.clientY - drag.clientY) <= 4) return;
      drag.moved = true;
      dragLine.hidden = false;
      setDragHint("拖到目标节点：建边前会实时检测环和重复边。", "warn");
    }
    var point = svgPoint(event);
    dragLine.setAttribute("x2", point.x);
    dragLine.setAttribute("y2", point.y);
    var element = document.elementFromPoint(event.clientX, event.clientY);
    var nodeEl = element && element.closest ? element.closest("g.node") : null;
    var target = nodeEl ? nodeEl.getAttribute("data-id") : null;
    if (target === drag.from) target = null;
    if (target !== drag.to) {
      drag.to = target;
      dragCheck = { ok: false, message: "" };
      var groups = nodeLayer.querySelectorAll("g.node");
      for (var i = 0; i < groups.length; i += 1) groups[i].classList.remove("target-ok", "target-bad");
      dragLine.setAttribute("class", "");
      if (!target) {
        setDragHint("拖到目标节点：建边前会实时检测环和重复边。", "warn");
        return;
      }
      var seq = ++dragSeq;
      setDragHint("检测中…", "warn");
      api("/api/edges/validate", { method: "POST", body: { from: drag.from, to: target } }).then(function () {
        if (seq !== dragSeq) return;
        dragCheck = { ok: true, message: "可以建边：松开即可添加。" };
        dragLine.setAttribute("class", "ok");
        setDragHint("绿色：可以建边。", "ok");
        if (nodeEl) nodeEl.classList.add("target-ok");
      }).catch(function (error) {
        if (seq !== dragSeq) return;
        dragCheck = { ok: false, message: error.message };
        dragLine.setAttribute("class", "bad");
        setDragHint("红色：" + error.message, "bad");
        if (nodeEl) nodeEl.classList.add("target-bad");
      });
    }
  }

  function endDrag(event) {
    if (!drag) return;
    var from = drag.from;
    var to = drag.to;
    var ok = dragCheck.ok;
    var message = dragCheck.message;
    var moved = drag.moved;
    drag = null;
    dragSeq += 1;
    state.dragged = true;
    setTimeout(function () { state.dragged = false; }, 160);
    clearDragVisual();
    if (!moved) {
      // Click on the +: the same dialog the toolbar button opens, with this node as start.
      // Deferred by one task so the click that ends this press cannot land on the modal
      // backdrop that is about to cover the pointer.
      setTimeout(function () { openRelation(from, "after"); }, 0);
      return;
    }
    if (!ok || !to) {
      if (message) toast(message, "bad");
      return;
    }
    api("/api/edges", { method: "POST", body: { from: from, to: to } }).then(function () {
      toast("已建立关系：『" + relationTitle(from) + "』→『" + relationTitle(to) + "』；收藏路径需要重新保存才能执行。");
      return goAnchor(state.anchor ? state.anchor.id : from, false, true);
    }).catch(function (error) { toast(error.message, "bad"); });
  }

  // ---------- relation builder (search-driven, canvas-independent) ----------
  function relationTitle(id) {
    if (!id) return "";
    return state.titles[id] || "已选节点";
  }

  function relationEdge() {
    var rel = state.relation;
    if (!rel || !rel.start || !rel.end) return null;
    return rel.dir === "before" ? { from: rel.end, to: rel.start } : { from: rel.start, to: rel.end };
  }

  function checkRelation() {
    var rel = state.relation;
    var box = $("relCheck");
    if (!rel || !box) return;
    var edge = relationEdge();
    if (!edge) {
      box.hidden = true;
      box.className = "relCheck";
      box.textContent = "";
      return;
    }
    var seq = rel.seq + 1;
    rel.seq = seq;
    box.hidden = false;
    box.className = "relCheck";
    box.textContent = "检测中…";
    api("/api/edges/validate", { method: "POST", body: edge }).then(function () {
      if (!state.relation || state.relation.seq !== seq) return;
      box.className = "relCheck ok";
      box.textContent = "绿色：可以建立关系 『" + relationTitle(edge.from) + "』→『" + relationTitle(edge.to) + "』。";
    }).catch(function (error) {
      if (!state.relation || state.relation.seq !== seq) return;
      box.className = "relCheck bad";
      box.textContent = "红色：" + error.message;
    });
  }

  function renderRelation() {
    var rel = state.relation;
    if (!rel) return;
    var start = $("relStart");
    var end = $("relEnd");
    if (start) {
      start.textContent = rel.start ? "『" + relationTitle(rel.start) + "』" : "（未选：点「搜索选择起点」）";
      start.className = "relPick" + (rel.start ? " set" : "");
    }
    if (end) {
      end.textContent = rel.end ? "『" + relationTitle(rel.end) + "』" : "（未选：点「搜索选择终点」）";
      end.className = "relPick" + (rel.end ? " set" : "");
    }
    var label = $("relSlotLabel");
    if (label) label.textContent = rel.slot === "start" ? "起点" : "终点";
    checkRelation();
  }

  // Opens the one dialog both entry points share: the node's + and the toolbar button.
  function openRelation(startId, defaultDir) {
    state.relation = {
      start: startId || null,
      end: null,
      dir: defaultDir === "before" ? "before" : "after",
      slot: startId ? "end" : "start",
      seq: 0
    };
    var body = '<div class="relRow"><span class="relLabel">起点</span><div class="relPick" id="relStart"></div>'
      + '<button class="btn small" data-action="rel-slot" data-slot="start">搜索选择起点</button></div>'
      + '<div class="relRow"><span class="relLabel">终点</span><div class="relPick" id="relEnd"></div>'
      + '<button class="btn small" data-action="rel-slot" data-slot="end">搜索选择终点</button></div>'
      + '<div class="relRow"><span class="relLabel">关系</span>'
      + '<label class="relChoice"><input type="radio" name="relDir" value="after"' + (state.relation.dir === "after" ? " checked" : "") + '> 作为该节点的后续（起点 → 终点）</label>'
      + '<label class="relChoice"><input type="radio" name="relDir" value="before"' + (state.relation.dir === "before" ? " checked" : "") + '> 作为该节点的前置（终点 → 起点）</label></div>'
      + '<div class="field"><label>搜索节点（语义 TOP3 + 关键词）</label>'
      + '<div class="row"><input id="relQuery" class="grow" placeholder="输入关键词或描述，例如：进入天翼云电脑"><button class="btn" data-action="rel-search">搜索</button></div></div>'
      + '<div class="muted" style="font-size:11px">当前搜索结果会填进：<b id="relSlotLabel">终点</b>。点一条结果即选中。</div>'
      + '<div id="relResults" class="relResults"><span class="muted">输入关键词后点「搜索」。画布上看不见的节点也能搜到。</span></div>'
      + '<div id="relCheck" class="relCheck" hidden></div>';
    showModal("建立关系", body);
    var foot = $("modalFoot");
    var cancel = document.createElement("button");
    cancel.className = "btn ghost";
    cancel.textContent = "取消";
    cancel.setAttribute("data-action", "close-modal");
    var submit = document.createElement("button");
    submit.className = "btn primary";
    submit.textContent = "建立关系";
    submit.setAttribute("data-action", "rel-submit");
    foot.appendChild(cancel);
    foot.appendChild(submit);
    renderRelation();
    setTimeout(function () { var query = $("relQuery"); if (query) query.focus(); }, 0);
  }

  function relationSearch() {
    var rel = state.relation;
    if (!rel) return;
    var input = $("relQuery");
    var box = $("relResults");
    if (!input || !box) return;
    var query = input.value.trim();
    if (query === "") { input.focus(); return; }
    box.innerHTML = '<span class="muted">检索中…（语义 + 关键词）</span>';
    api("/api/search?q=" + encodeURIComponent(query) + "&threshold=" + state.settings.searchThreshold).then(function (data) {
      if (!state.relation) return;
      var rows = [];
      var seen = {};
      (data.candidates || []).forEach(function (candidate) {
        var node = candidate.node;
        if (!node || seen[node.id]) return;
        seen[node.id] = true;
        state.titles[node.id] = node.title;
        rows.push({ id: node.id, title: node.title, kind: candidate.meets_threshold === false ? "语义 · 未达阈值" : "语义", score: pct(candidate.similarity) });
      });
      (data.keyword || []).forEach(function (candidate) {
        var node = candidate.node;
        if (!node || seen[node.id]) return;
        seen[node.id] = true;
        state.titles[node.id] = node.title;
        rows.push({ id: node.id, title: node.title, kind: "关键词", score: scoreOf(candidate.score) });
      });
      if (rows.length === 0) {
        box.innerHTML = '<span class="muted">没有命中；换个说法再搜，或先新建节点。</span>';
        return;
      }
      box.innerHTML = rows.map(function (row) {
        return '<button class="relResult" data-action="rel-use" data-id="' + esc(row.id) + '"><b>' + esc(row.title || "未命名节点") + '</b> <span class="muted">' + esc(row.kind) + ' · ' + esc(row.score) + '</span></button>';
      }).join("");
    }).catch(function (error) { box.innerHTML = '<span class="muted">检索失败：' + esc(error.message) + '</span>'; });
  }

  function relationUse(id) {
    var rel = state.relation;
    if (!rel || !id) return;
    if (rel.slot === "start") {
      rel.start = id;
      rel.slot = "end";
    } else {
      rel.end = id;
    }
    renderRelation();
  }

  function relationSubmit() {
    var rel = state.relation;
    if (!rel) return;
    if (!rel.start) { toast("先选起点：点「搜索选择起点」再挑一个节点。", "warn"); return; }
    if (!rel.end) { toast("再选终点：点「搜索选择终点」或点一条搜索结果。", "warn"); return; }
    var edge = relationEdge();
    if (!edge) return;
    var fromTitle = relationTitle(edge.from);
    var toTitle = relationTitle(edge.to);
    api("/api/edges", { method: "POST", body: edge }).then(function () {
      state.relation = null;
      closeModal();
      toast("已建立关系：『" + fromTitle + "』→『" + toTitle + "』");
      if (state.anchor) return goAnchor(state.anchor.id, false, true);
    }).catch(function (error) { toast(error.message, "bad"); });
  }

  // ---------- deleted nodes ----------
  function loadDeleted() {
    var list = $("statusList");
    if (!list) return;
    state.deletedOpen = true;
    list.hidden = false;
    list.innerHTML = '<span class="muted">读取中…</span>';
    api("/api/nodes?status=deleted").then(function (data) {
      if (!state.deletedOpen) return;
      if (data.nodes.length === 0) {
        list.innerHTML = '<div class="hintBox">没有已删除的节点。</div>';
        return;
      }
      list.innerHTML = '<div class="hintBox" style="margin-bottom:8px">软删除的节点仍在库里；恢复后重新参与检索、连线和路径执行。</div>'
        + data.nodes.map(function (node) {
          return '<div class="deletedRow"><span class="grow">' + esc(node.title || "未命名节点") + '</span><span class="tag bad">已删除</span>'
            + '<button class="btn small primary" data-action="restore-node" data-id="' + esc(node.id) + '">恢复</button></div>';
        }).join("");
    }).catch(function (error) { list.innerHTML = '<div class="hintBox">读取失败：' + esc(error.message) + '</div>'; });
  }

  function hideDeleted() {
    state.deletedOpen = false;
    var list = $("statusList");
    if (list) { list.hidden = true; list.innerHTML = ""; }
  }

  // ---------- detail drawer width ----------
  function bindDrawerResize() {
    var handle = $("detailResize");
    var drawer = $("detail");
    if (!handle || !drawer || handle.getAttribute("data-bound") === "1") return;
    handle.setAttribute("data-bound", "1");
    var active = false;
    var startX = 0;
    var startWidth = 0;
    handle.addEventListener("pointerdown", function (event) {
      if (window.innerWidth <= 1100) return;
      active = true;
      startX = event.clientX;
      startWidth = drawer.getBoundingClientRect().width;
      handle.classList.add("active");
      if (handle.setPointerCapture) { try { handle.setPointerCapture(event.pointerId); } catch (err) {} }
      event.preventDefault();
    });
    handle.addEventListener("pointermove", function (event) {
      if (!active) return;
      var ceiling = Math.min(720, Math.max(360, window.innerWidth * 0.6));
      var width = Math.min(Math.max(320, startWidth - (event.clientX - startX)), ceiling);
      drawer.style.setProperty("--drawer-width", width + "px");
    });
    var stop = function () { active = false; handle.classList.remove("active"); };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  // ---------- action router ----------
  function actionOf(target) {
    var el = target && target.closest ? target.closest("[data-action]") : null;
    return el;
  }

  document.addEventListener("click", function (event) {
    var card = event.target && event.target.closest ? event.target.closest(".cand[data-node]") : null;
    if (card && $("searchPanel").contains(card)) {
      state.selectedCandidate = card.getAttribute("data-node");
      var cards = $("searchPanel").querySelectorAll(".cand[data-node]");
      for (var c = 0; c < cards.length; c += 1) cards[c].classList.toggle("selected", cards[c] === card);
    }
    var el = actionOf(event.target);
    if (!el) return;
    var action = el.getAttribute("data-action");
    var id = el.getAttribute("data-id");
    event.preventDefault();
    if (state.dragged && el.closest && el.closest("g.node")) return;
    if (action === "anchor") {
      closeModal();
      navigateTemp(id);
    } else if (action === "detail-anchor") {
      if (state.anchor) {
        var currentId = state.anchor.id;
        guardMainView("打开当前节点的详情").then(function (proceed) {
          if (proceed) openDetail(currentId);
        });
      }
    } else if (action === "copy-anchor") {
      if (state.anchor) doCopy(state.anchor.id);
    } else if (action === "detail" || action === "open-node") {
      var openId = id;
      guardMainView("打开另一个节点的详情").then(function (proceed) {
        if (!proceed) return;
        closeModal();
        hideDetail();
        openDetail(openId);
      });
    } else if (action === "crumb") {
      var index = Number(el.getAttribute("data-index"));
      state.stack = state.stack.slice(0, index + 1);
      state.anchor = null;
      goAnchor(state.stack[state.stack.length - 1], false);
    } else if (action === "back-stack") {
      if (state.stack.length > 1) {
        state.stack.pop();
        state.anchor = null;
        goAnchor(state.stack[state.stack.length - 1], false);
      }
    } else if (action === "clear-anchor") {
      state.anchor = null;
      state.graph = null;
      state.stack = [];
      clearGraph();
      show($("emptyHint"), true);
      renderCrumbs();
    } else if (action === "tab") {
      var tab = el.getAttribute("data-tab");
      state.currentTab = tab;
      var tabs = document.querySelectorAll("[data-action=tab]");
      for (var i = 0; i < tabs.length; i += 1) tabs[i].classList.toggle("active", tabs[i].getAttribute("data-tab") === tab);
      show($("tab-graph"), tab === "graph");
      show($("tab-index"), tab === "index");
      show($("tab-log"), tab === "log");
      if (tab === "index") loadPaths();
      if (tab === "log") loadLog();
    } else if (action === "return-view") {
      returnView();
    } else if (action === "new-node") {
      guardMainView("打开新建节点窗口").then(function (proceed) {
        if (!proceed) return;
        hideDetail();
        openCreate({});
      });
    } else if (action === "close-search") {
      $("searchPanel").hidden = true;
    } else if (action === "close-detail") {
      closeDetailGuarded();
    } else if (action === "close-modal") {
      closeModalGuarded();
    } else if (action === "guard-save") {
      if (state.guard && state.guard.mode === "confirm") { closeGuard(true); return; }
      saveMainView().then(function () { closeGuard(true); }).catch(function (error) { toast(error.message, "bad"); });
    } else if (action === "guard-discard") {
      closeGuard(true);
    } else if (action === "guard-cancel") {
      closeGuard(false);
    } else if (action === "reuse") {
      var sim = Number(el.getAttribute("data-sim"));
      api("/api/reuse", { method: "POST", body: { node_id: id, query: state.query, similarity: sim } }).then(function () {
        toast("已复用该节点（节点本身不变，也没有新建）。");
        navigateTemp(id);
      }).catch(function (error) { toast(error.message, "bad"); });
    } else if (action === "variant") {
      var variantOf = id;
      guardMainView("以它为起点新建节点").then(function (proceed) {
        if (!proceed) return;
        api("/api/nodes/" + encodeURIComponent(variantOf)).then(function (detail) {
          hideDetail();
          closeModal();
          openCreate({ title: detail.node.title + "（变体）", description: detail.node.description, derived_from: detail.node.id });
        }).catch(function (error) { toast(error.message, "bad"); });
      });
    } else if (action === "create-node") {
      var derived = el.getAttribute("data-derived") || null;
      createNodeFromModal(derived).then(function (data) {
        closeModal();
        state.mainView = null;
        refreshDirtyUI();
        return goAnchor(data.node.id, true);
      }).catch(function (error) { toast(error.message, "bad"); });
    } else if (action === "save-node") {
      saveDetailNode(id).catch(function (error) { toast(error.message, "bad"); });
    } else if (action === "copy-node") {
      doCopy(id);
    } else if (action === "delete-node") {
      askConfirm({
        title: "删除这个节点？",
        body: '<p>删除是<b>软删除</b>：节点文件和连线都留在库里，只是不再出现在检索、连线和路径执行里。</p>'
          + '<p>之后可以在左侧「节点状态 → 已删除」里恢复它。</p>',
        confirmText: "删除",
        danger: true
      }).then(function (ok) {
        if (!ok) return;
        api("/api/nodes/" + encodeURIComponent(id) + "/delete", { method: "POST", body: {} }).then(function () {
          hideDetail();
          toast("已删除，可在「已删除」筛选里恢复。");
          if (state.deletedOpen) loadDeleted();
          // The anchor may be the node just deleted: drop the canvas instead of asking
          // the server for a neighborhood it must refuse.
          if (!state.anchor || state.anchor.id === id) {
            state.anchor = null;
            state.graph = null;
            state.stack = [];
            clearGraph();
            show($("emptyHint"), true);
            renderCrumbs();
            return;
          }
          return goAnchor(state.anchor.id, false, true);
        }).catch(function (error) { toast(error.message, "bad"); });
      });
    } else if (action === "restore-node") {
      api("/api/nodes/" + encodeURIComponent(id) + "/restore", { method: "POST", body: {} }).then(function (data) {
        var title = data.node.title || "未命名节点";
        toast("已恢复『" + title + "』，重新参与检索与执行。");
        if (state.deletedOpen) loadDeleted();
        return openDetail(id).then(function () { return goAnchor(id, false, true); });
      }).catch(function (error) { toast(error.message, "bad"); });
    } else if (action === "delete-edge") {
      var from = el.getAttribute("data-from");
      var to = el.getAttribute("data-to");
      api("/api/edges", { method: "DELETE", body: { from: from, to: to } }).then(function () {
        toast("连线已删除；引用它的收藏会变成有缺陷。");
        return openDetail(from).then(function () { return goAnchor(state.anchor ? state.anchor.id : from, false, true); });
      }).catch(function (error) { toast(error.message, "bad"); });
    } else if (action === "upload-shot") {
      var file = $("shotFile").files[0];
      var caption = $("shotCaption").value.trim();
      if (!file) { toast("先选一张图片。", "warn"); return; }
      if (caption === "") { toast("截图必须写一句说明。", "warn"); return; }
      var reader = new FileReader();
      reader.onload = function () {
        api("/api/nodes/" + encodeURIComponent(id) + "/screenshots", { method: "POST", body: { caption: caption, data: String(reader.result), file_name: file.name } }).then(function () {
          toast("截图已保存，并已参与检索。");
          return openDetail(id);
        }).catch(function (error) { toast(error.message, "bad"); });
      };
      reader.readAsDataURL(file);
    } else if (action === "delete-shot") {
      var shot = el.getAttribute("data-shot");
      api("/api/nodes/" + encodeURIComponent(id) + "/screenshots/" + encodeURIComponent(shot), { method: "DELETE" }).then(function () {
        toast("截图已删除。");
        return openDetail(id);
      }).catch(function (error) { toast(error.message, "bad"); });
    } else if (action === "open-relation") {
      guardCreateModal("打开建立关系窗口").then(function (proceed) {
        if (proceed) openRelation(state.anchor ? state.anchor.id : null, "after");
      });
    } else if (action === "relate-node") {
      var dir = el.getAttribute("data-dir");
      guardCreateModal("打开建立关系窗口").then(function (proceed) {
        if (proceed) openRelation(id, dir === "before" ? "before" : "after");
      });
    } else if (action === "rel-slot") {
      var slot = el.getAttribute("data-slot");
      if (state.relation) {
        state.relation.slot = slot === "start" ? "start" : "end";
        renderRelation();
        var focused = $("relQuery");
        if (focused) focused.focus();
      }
    } else if (action === "rel-search") {
      relationSearch();
    } else if (action === "rel-use") {
      relationUse(id);
    } else if (action === "rel-submit") {
      relationSubmit();
    } else if (action === "filter-deleted") {
      loadDeleted();
    } else if (action === "filter-active") {
      hideDeleted();
    } else if (action === "open-stats") {
      guardCreateModal("打开统计看板").then(function (proceed) { if (proceed) openStats(); });
    } else if (action === "save-settings") {
      var threshold = Number($("thresholdInput").value);
      var semanticFloor = Number($("floorInput").value);
      if (!isFinite(threshold) || threshold < 0 || threshold > 1 || !isFinite(semanticFloor) || semanticFloor < 0 || semanticFloor > 1) {
        toast("阈值和语义地板都要在 0–1 之间。", "warn");
        return;
      }
      api("/api/settings", { method: "PUT", body: { searchThreshold: threshold, semanticFloor: semanticFloor } }).then(function (data) {
        state.settings = data.settings;
        toast("已保存：阈值 " + pct(data.settings.searchThreshold) + "，语义地板 " + pct(data.settings.semanticFloor));
      }).catch(function (error) { toast(error.message, "bad"); });
    } else if (action === "match-index") {
      matchIndex();
    } else if (action === "save-path") {
      guardCreateModal("保存当前路径为收藏").then(function (proceed) { if (proceed) savePathFromStack(); });
    } else if (action === "create-path") {
      api("/api/paths", { method: "POST", body: { name: $("pathName").value, summary: $("pathSummary").value, node_sequence: state.stack } }).then(function () {
        closeModal();
        toast("收藏已保存；执行入口 index.json 已更新。");
        return loadPaths();
      }).catch(function (error) { toast(error.message, "bad"); });
    } else if (action === "view-path") {
      var forceView = el.getAttribute("data-force") === "1";
      guardCreateModal("查看完整路径").then(function (proceed) { if (proceed) viewPath(id, forceView); });
    } else if (action === "run-path") {
      testPath(id, el.getAttribute("data-force") === "1");
    } else if (action === "delete-path") {
      if (!confirm("删除这条收藏？节点和连线不会删除。")) return;
      api("/api/paths/" + encodeURIComponent(id), { method: "DELETE" }).then(function () {
        toast("收藏已删除。");
        return loadPaths();
      }).catch(function (error) { toast(error.message, "bad"); });
    } else if (action === "judge-met" || action === "judge-unmet" || action === "judge-llm" || action === "skip-step" || action === "reset-step") {
      runAction(action, id);
    }
  });

  function doCopy(id) {
    api("/api/nodes/" + encodeURIComponent(id) + "/copy", { method: "POST", body: {} }).then(function (data) {
      toast("副本已创建（内容复制，连线需自己重建）。");
      return goAnchor(data.node.id, true).then(function () { return openDetail(data.node.id); });
    }).catch(function (error) { toast(error.message, "bad"); });
  }

  // The 操作记录 tab: the server already resolved every id to a Chinese title, so no
  // node-/path-/decision- id can reach the DOM from here.
  function loadLog() {
    api("/api/log?limit=60").then(function (data) {
      if (data.entries.length === 0) { $("logList").innerHTML = '<span class="muted">还没有操作记录。</span>'; return; }
      $("logList").innerHTML = data.entries.map(function (entry) {
        var candidates = (entry.candidates || []).map(function (candidate) {
          return '『' + esc(candidate.title) + '』' + (candidate.deleted ? '（已删除）' : '')
            + (candidate.similarity == null ? '' : ' ' + pctWhole(candidate.similarity));
        }).join('、');
        var html = '<div class="pathRow"><h4>' + esc(entry.sentence) + '</h4>';
        if (entry.diff_summary) html += '<p>' + esc(entry.diff_summary) + '</p>';
        if (candidates !== '') html += '<p class="muted">参考候选：' + candidates + '</p>';
        if (entry.similarity != null) html += '<p class="muted">当时相似度 ' + pct(entry.similarity) + '</p>';
        html += '<p class="mono muted">' + esc(formatTs(entry.ts)) + ' · 操作人 ' + esc(entry.operator) + '</p></div>';
        return html;
      }).join("");
    }).catch(function (error) { toast(error.message, "bad"); });
  }

  // ---------- wiring ----------
  $("searchForm").addEventListener("submit", function (event) { event.preventDefault(); doSearch(); });
  $("indexQuery").addEventListener("keydown", function (event) { if (event.key === "Enter") matchIndex(); });
  document.addEventListener("change", function (event) {
    var target = event.target;
    if (!target || target.name !== "relDir") return;
    if (!state.relation) return;
    state.relation.dir = target.value === "before" ? "before" : "after";
    checkRelation();
  });
  document.addEventListener("keydown", function (event) {
    if (event.key !== "Enter") return;
    var target = event.target;
    if (!target) return;
    if (target.id === "relQuery") { event.preventDefault(); relationSearch(); }
  });
  svg.addEventListener("pointerdown", beginDrag);
  window.addEventListener("pointermove", moveDrag);
  window.addEventListener("pointerup", endDrag);
  svg.addEventListener("click", function (event) {
    if (state.dragged) return;
    var detail = event.target.closest ? event.target.closest("[data-detail]") : null;
    if (detail) {
      event.stopPropagation();
      var detailId = detail.getAttribute("data-detail");
      guardMainView("打开另一个节点的详情").then(function (proceed) {
        if (!proceed) return;
        hideDetail();
        openDetail(detailId);
      });
      return;
    }
    var node = event.target.closest ? event.target.closest("g.node") : null;
    if (node) {
      var nodeId = node.getAttribute("data-id");
      if (!$("searchPanel").hidden) navigateTemp(nodeId);
      else goAnchor(nodeId, true);
    }
  });
  document.addEventListener("input", function (event) {
    var target = event.target;
    if (!target) return;
    if (target.id === "createTitle" || target.id === "createDesc"
      || target.id === "detailTitle" || target.id === "detailDesc") {
      refreshDirtyUI();
    }
  });
  document.addEventListener("keydown", function (event) {
    if ((event.key === "F5" || ((event.ctrlKey || event.metaKey) && (event.key === "r" || event.key === "R"))) && isMainDirty()) {
      event.preventDefault();
      askUnsaved("刷新页面").then(function (proceed) { if (proceed) location.reload(); });
      return;
    }
    if (event.key === "Escape") {
      if (!$("guardRoot").hidden) closeGuard(false);
      else if (!$("modalRoot").hidden) closeModalGuarded();
      else if (!$("detail").hidden) closeDetailGuarded();
      else if (!$("searchPanel").hidden) $("searchPanel").hidden = true;
    }
  });
  window.addEventListener("beforeunload", function (event) {
    if (!isMainDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  });
  $("modalRoot").addEventListener("click", function (event) { if (event.target === $("modalRoot")) closeModalGuarded(); });
  $("guardRoot").addEventListener("click", function (event) { if (event.target === $("guardRoot")) closeGuard(false); });

  api("/api/state").then(function (data) {
    state.settings = data.settings;
    $("libPath").textContent = data.dir;
    $("libPath").title = data.dir;
    $("newBtn").classList.add("pulse");
  }).catch(function (error) {
    $("libPath").textContent = "无法读取库：" + error.message;
  });
  renderCrumbs();
})();
</script>
</body>
</html>`
