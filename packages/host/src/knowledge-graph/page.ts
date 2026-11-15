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
<title>经验库</title>
<style>
  :root {
    --bg: #f2e2c0;
    --panel: #fbf1dc;
    --panel2: #f7e9cd;
    --line: #d9c39a;
    --line2: #c4a877;
    --text: #3a2b1c;
    --muted: #7a6148;
    --accent: #2f6b4f;
    --accent2: #3f8a63;
    --warn: #b45309;
    --danger: #b91c1c;
    --ok: #15803d;
    --shadow: 0 16px 40px rgba(96, 62, 18, .22);
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; color: var(--text);
    background:
      linear-gradient(180deg, rgba(255, 255, 255, .38), rgba(255, 255, 255, 0) 340px),
      repeating-linear-gradient(90deg, #f2e2c0 0 4px, #eddcb6 4px 8px),
      #f2e2c0;
    font: 15px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    display: flex; flex-direction: column; overflow: hidden;
  }
  button { font: inherit; color: inherit; cursor: pointer; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  input, textarea, select {
    font: inherit; color: var(--text); background: #fffaf0; border: 1px solid var(--line);
    border-radius: 8px; padding: 7px 9px; outline: none;
  }
  input:focus, textarea:focus, select:focus { border-color: var(--accent2); }
  .btn {
    background: var(--panel2); border: 1px solid var(--line); border-radius: 8px;
    padding: 7px 12px; white-space: nowrap;
  }
  .btn:hover { border-color: var(--line2); background: #efe0bf; }
  .btn.primary { background: var(--accent2); border-color: var(--accent2); color: #fdfaf2; font-weight: 600; }
  .btn.primary:hover { background: var(--accent); }
  .btn.ghost { background: transparent; }
  .btn.danger { color: var(--danger); border-color: #9a3412; }
  .btn.small { padding: 3px 8px; font-size: 13px; }
  .btn.pulse { animation: pulse 1.2s ease-in-out infinite; border-color: var(--accent); color: var(--accent); }
  @keyframes pulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(45, 212, 191, .45); } 50% { box-shadow: 0 0 0 7px rgba(45, 212, 191, 0); } }

  #topbar {
    height: 66px; flex: 0 0 66px; display: flex; align-items: center; gap: 18px;
    padding: 0 18px; background: #ecd9b4; border-bottom: 1px solid var(--line);
  }
  .brand { display: flex; align-items: center; gap: 11px; min-width: 230px; }
  .logo {
    width: 36px; height: 36px; border-radius: 10px; display: grid; place-items: center;
    background: linear-gradient(145deg, #e3efe3, #e3efe3); color: var(--accent);
    border: 1px solid #2f6b4f; font-size: 20px;
  }
  .brand .title { font-weight: 700; letter-spacing: .04em; }
  .brand .sub { color: var(--muted); font-size: 12px; max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #searchForm { display: flex; gap: 8px; margin: 6px 0 2px; }
  #searchInput { flex: 1; min-width: 0; padding: 10px 13px; background: #fffaf0; font-weight: 500; }
  .topActions { display: flex; gap: 8px; margin-left: auto; }

  #crumbs {
    flex: 0 0 42px; display: flex; align-items: center; gap: 8px; padding: 0 18px;
    border-bottom: 1px solid var(--line); background: #f5e6c8; color: var(--muted);
    font-size: 13px; overflow: hidden;
  }
  #crumbs .label { color: var(--accent); letter-spacing: .08em; }
  #crumbList { display: flex; align-items: center; gap: 5px; overflow-x: auto; white-space: nowrap; min-width: 0; }
  .crumb { border: 1px solid var(--line); background: #f2e3c4; color: var(--text); border-radius: 999px; padding: 3px 10px; font-size: 13px; }
  .crumb.current { border-color: var(--accent2); color: var(--accent); }
  #returnBtn { margin-left: auto; flex: 0 0 auto; }
  #returnBtn:not(:disabled) { border-color: var(--accent2); color: var(--accent); background: #e6efe4; font-weight: 600; }
  #backBtn { flex: 0 0 auto; }
  .dirtyFlag { border: 1px solid #8a5a12; background: rgba(245, 158, 11, .12); color: #b45309; border-radius: 999px; padding: 2px 10px; font-size: 11.5px; white-space: nowrap; }

  main { flex: 1; display: flex; min-height: 0; }
  #side {
    width: 292px; flex: 0 0 292px; background: var(--panel); border-right: 1px solid var(--line);
    display: flex; flex-direction: column; min-height: 0;
  }
  .tabs { display: flex; border-bottom: 1px solid var(--line); }
  .tabs button { flex: 1; background: transparent; border: 0; border-bottom: 2px solid transparent; padding: 11px 6px; color: var(--muted); }
  .tabs button.active { color: var(--text); border-bottom-color: var(--accent2); }
  .tabpane { padding: 14px; overflow: auto; flex: 1; min-height: 0; }
  .sectionTitle { display: flex; align-items: center; gap: 8px; color: var(--text); font-weight: 700; font-size: 13px; letter-spacing: .06em; margin: 16px 0 8px; }
  .sectionTitle:first-child { margin-top: 0; }
  .sectionTitle .grow { flex: 1; }
  .legend { display: grid; gap: 7px; margin: 10px 0 14px; color: var(--text); font-weight: 500; font-size: 13px; }
  .legend span { display: inline-block; width: 11px; height: 11px; border-radius: 3px; margin-right: 7px; vertical-align: -1px; }
  .legend .a { background: var(--accent2); }
  .legend .p { background: #1d4ed8; }
  .legend .c { background: #6d28d9; }
  .legend .s { background: #7a6148; }
  .hintBox { border: 1px dashed var(--line2); border-radius: 10px; padding: 11px; color: var(--text); font-weight: 500; font-size: 13px; background: #fffaf0; }
  .field { display: grid; gap: 5px; margin-bottom: 9px; }
  .field label { color: var(--muted); font-size: 13px; }
  .row { display: flex; gap: 6px; align-items: center; }
  .row > * { min-width: 0; }
  .grow { flex: 1; }

  #stage { flex: 1; position: relative; min-width: 0; background: radial-gradient(circle at 50% 42%, #f7e9cd 0%, #f2e2c0 62%); overflow: hidden; }
  #graph { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
  #emptyHint {
    position: absolute; left: 50%; top: 47%; transform: translate(-50%, -50%);
    text-align: center; color: var(--muted); pointer-events: none;
  }
  #emptyHint .big { font-size: 20px; color: #d9c39a; margin-bottom: 10px; }
  #emptyHint h2 { color: var(--text); font-weight: 600; margin: 0 0 7px; }
  #emptyHint p { margin: 0; font-size: 14px; }

  #searchPanel {
    position: absolute; left: 18px; top: 18px; width: min(880px, calc(100% - 36px));
    max-height: calc(100% - 36px); overflow: auto; background: rgba(16, 23, 31, .98);
    border: 1px solid var(--line2); border-radius: 14px; box-shadow: var(--shadow); padding: 15px;
  }
  .searchHead { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: nowrap; }
  .searchHead h3 { margin: 0; font-size: 15px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .searchHeadActions { display: flex; gap: 8px; flex: 0 0 auto; }
  .searchNote { color: var(--muted); font-size: 12px; line-height: 1.6; margin: 0 0 12px; }
  .resultColumns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; align-items: start; }
  .resultCol { min-width: 0; }
  .colHead { display: flex; flex-direction: column; gap: 1px; padding: 0 2px 7px; margin-bottom: 9px; border-bottom: 1px solid var(--line); }
  .colHead b { font-size: 14px; }
  .colHead span { font-size: 12px; color: var(--muted); }
  .colEmpty { border: 1px dashed var(--line); border-radius: 10px; padding: 14px 10px; text-align: center; color: var(--muted); font-size: 13px; }
  .subHead { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; margin: 2px 0 7px; color: var(--muted); font-size: 11.5px; }
  .subHead b { font-size: 13px; color: var(--text); }
  .subHead.unmetHead b { color: var(--warn); }
  .cand { border: 1px solid var(--line); border-radius: 11px; padding: 10px; margin-bottom: 9px; background: #f7e9cd; min-width: 0; }
  .cand:hover { border-color: var(--line2); }
  .cand.selected { border-color: var(--accent2); background: #e6efe4; box-shadow: inset 0 0 0 1px rgba(45, 212, 191, .35); }
  .cand h4 { margin: 0 0 3px; font-size: 13.5px; overflow-wrap: anywhere; }
  .sim { float: right; color: var(--accent); font-variant-numeric: tabular-nums; font-size: 13px; }
  .simbar { height: 3px; background: #e8d6b0; border-radius: 3px; overflow: hidden; margin: 7px 0; }
  .simbar i { display: block; height: 100%; background: linear-gradient(90deg, #2f6b4f, var(--accent)); }
  .diff { color: #5a4630; font-size: 13px; margin: 6px 0; }
  .diff b { color: var(--warn); font-weight: 600; }
  .descPair { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin: 7px 0; }
  .descPair div { background: #f7e9cd; border: 1px solid var(--line); border-radius: 8px; padding: 7px; font-size: 12px; color: var(--muted); max-height: 96px; overflow: auto; }
  .descPair b { display: block; color: #5a4630; font-weight: 600; margin-bottom: 3px; }
  .candActions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .emptyResult { text-align: center; padding: 8px 0 2px; }
  .emptyResult h3 { margin: 4px 0 5px; }
  .emptyResult p { color: var(--muted); font-size: 13px; margin: 0 0 11px; }
  .emptyResult .newCta { padding: 11px 18px; font-size: 16px; }
  .resultBlock { margin-bottom: 14px; }
  .blockHead { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin: 0 0 7px; }
  .blockHead b { font-size: 14px; }
  .blockHead span { font-size: 12px; }
  .emptyLine { font-size: 12px; padding: 7px 9px; border: 1px dashed var(--line); border-radius: 9px; }
  .badges { display: flex; flex-wrap: wrap; gap: 5px; margin: 3px 0 5px; }
  .badge { display: inline-block; font-size: 10.5px; line-height: 1.5; padding: 0 6px; border-radius: 999px; border: 1px solid var(--line2); color: var(--muted); }
  .badge.simBadge { border-color: #2f6b4f; color: var(--accent); }
  .badge.kwBadge { border-color: #8a5a12; color: var(--warn); }
  .badge.unmetBadge { border-color: #8a5a12; color: var(--warn); background: rgba(245, 158, 11, .1); }
  .cand.unmet { border-style: dashed; border-color: #7a5520; background: #fffaf0; opacity: .78; }
  .cand.unmet:hover { opacity: .95; border-color: #92400e; }
  .cand.unmet h4 { color: #5a4630; font-weight: 500; }
  .cand.unmet .sim { color: var(--warn); }
  .cand.unmet .simbar i { background: linear-gradient(90deg, #8a5a12, var(--warn)); }
  .unmetNote { border: 1px dashed #7a3f12; background: rgba(245, 158, 11, .06); color: #a16207; border-radius: 9px; padding: 7px 9px; font-size: 11.5px; margin: 8px 0; }
  .blockHead.unmetHead b { color: var(--warn); }
  .kwsim { float: right; color: var(--warn); font-variant-numeric: tabular-nums; font-size: 13px; }
  .hitLine { font-size: 11.5px; color: #5a4630; margin: 5px 0 6px; word-break: break-word; }
  .hitLine mark { background: #7c4a03; color: #7c4a03; border-radius: 3px; padding: 0 2px; }
  .muted { color: var(--muted); }
  .mono { font-family: "Cascadia Code", Consolas, monospace; }
  .tag { display: inline-block; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; font-size: 12px; color: var(--muted); }
  .tag.ok { color: var(--ok); border-color: #2f6b4f; }
  .tag.bad { color: var(--danger); border-color: #9a3412; }
  .tag.warn { color: var(--warn); border-color: #7a5520; }

  #dragHint {
    position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%);
    padding: 7px 13px; border-radius: 999px; background: #f7e9cd; border: 1px solid var(--line2);
    font-size: 13px; box-shadow: var(--shadow); pointer-events: none; max-width: 80%;
  }
  #dragHint.ok { color: var(--ok); border-color: #2f6b4f; }
  #dragHint.bad { color: var(--danger); border-color: #a8552a; }
  #toast {
    position: fixed; right: 22px; bottom: 22px; z-index: 60; max-width: 420px;
    background: #f2e3c4; border: 1px solid var(--line2); border-left: 3px solid var(--accent2);
    border-radius: 9px; padding: 10px 13px; box-shadow: var(--shadow); font-size: 14px;
  }
  #toast.bad { border-left-color: var(--danger); }
  #toast.warn { border-left-color: var(--warn); }

  .consoleNote { border: 1px solid #7a3f12; background: rgba(245, 158, 11, .08); color: #a16207; border-radius: 9px; padding: 8px 10px; font-size: 11.5px; line-height: 1.55; margin-bottom: 10px; }
  .consoleHint { color: #b8860b; font-size: 12px; line-height: 1.5; margin: 7px 0 0; }
  .tag.unsaved { color: #b45309; border-color: #8a5a12; background: rgba(245, 158, 11, .12); }

  #guardRoot { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; background: rgba(3, 7, 10, .72); padding: 24px; }
  #guardRoot[hidden] { display: none; }
  #guardCard { width: min(480px, 94vw); background: #f7e9cd; border: 1px solid var(--line2); border-radius: 14px; box-shadow: var(--shadow); }
  #guardHead { padding: 15px 16px 0; font-size: 16px; font-weight: 600; }
  #guardBody { padding: 9px 16px 15px; color: var(--muted); font-size: 12.5px; line-height: 1.65; }
  #guardBody b { color: var(--text); }
  #guardFoot { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 16px; border-top: 1px solid var(--line); }

  #detail {
    position: fixed; top: 66px; right: 0; bottom: 0;
    width: var(--drawer-width, 33vw); min-width: 340px; max-width: min(640px, 92vw); z-index: 30;
    background: #f7e9cd; border-left: 1px solid var(--line2); box-shadow: -18px 0 45px rgba(96, 62, 18, .20);
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
  #detail h2 { margin: 0 0 3px; font-size: 18px; }
  #detail .meta { color: var(--muted); font-size: 12px; margin-bottom: 12px; word-break: break-all; }
  #detail .block { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 12px; }
  #detail .block h3 { margin: 0 0 8px; font-size: 13px; color: var(--muted); letter-spacing: .06em; }
  .shots { display: grid; gap: 10px; }
  .shot { border: 1px solid var(--line); border-radius: 9px; overflow: hidden; background: #f7e9cd; }
  .shot img { width: 100%; display: block; max-height: 230px; object-fit: contain; background: #fffaf0; }
  .shot figcaption { padding: 7px 8px; font-size: 13px; color: #5a4630; display: flex; gap: 6px; align-items: center; }
  .edgeRow { display: flex; align-items: center; gap: 6px; padding: 5px 0; border-bottom: 1px dashed #efe0bf; font-size: 13px; }
  .edgeRow .grow { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .actionGrid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
  .actionGrid .wide { grid-column: span 2; }

  #modalRoot { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; background: rgba(3, 7, 10, .7); padding: 24px; }
  #modalRoot[hidden] { display: none; }
  #modal {
    width: min(880px, 96vw); max-height: 88vh; display: flex; flex-direction: column;
    background: #f7e9cd; border: 1px solid var(--line2); border-radius: 14px; box-shadow: var(--shadow);
  }
  #modalHead { display: flex; align-items: center; gap: 10px; padding: 13px 16px; border-bottom: 1px solid var(--line); }
  #modalHead h2 { margin: 0; font-size: 17px; flex: 1; }
  #modalBody { padding: 16px; overflow: auto; }
  #modalFoot { padding: 12px 16px; border-top: 1px solid var(--line); display: flex; gap: 8px; justify-content: flex-end; }
  .statGrid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 9px; margin-bottom: 15px; }
  .stat { background: #fffaf0; border: 1px solid var(--line); border-radius: 10px; padding: 10px; }
  .stat b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
  .stat span { color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 7px; border-bottom: 1px solid #efe0bf; vertical-align: top; }
  th { color: var(--muted); font-weight: 500; }
  .pathRow { border: 1px solid var(--line); border-radius: 10px; padding: 9px; margin-bottom: 8px; background: #f5e6c8; }
  .pathRow h4 { margin: 0 0 3px; font-size: 14px; }
  .pathRow p { margin: 3px 0; color: var(--muted); font-size: 12px; }
  .steps { display: grid; gap: 7px; margin: 10px 0; }
  .step { display: flex; gap: 9px; align-items: flex-start; border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px; background: #fffaf0; }
  .step.current { border-color: var(--accent2); background: #e6efe4; }
  .step.met { border-color: #2f6b4f; opacity: .82; }
  .step.unmet { border-color: #a8552a; background: #fbe9e3; }
  .step.skipped { opacity: .55; }
  .stepIcon { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; background: #f2e3c4; font-size: 13px; flex: 0 0 22px; }
  .step .body { flex: 1; min-width: 0; }
  .step .body b { font-size: 14px; }
  .step .body p { margin: 2px 0; color: var(--muted); font-size: 12px; }
  .runMsg { border: 1px solid var(--line2); border-left: 3px solid var(--accent2); border-radius: 9px; padding: 10px 12px; background: #f7e9cd; margin-bottom: 12px; font-size: 13px; }
  .runMsg.blocked { border-left-color: var(--danger); }
  .runMsg.complete { border-left-color: var(--ok); }
  .runActions { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 10px; }
  .blocker { border: 1px solid #9a3412; background: #fbe9e3; border-radius: 9px; padding: 9px; margin: 8px 0; font-size: 13px; }
  .blocker .row { margin-top: 6px; flex-wrap: wrap; }
  #modalBody pre { white-space: pre-wrap; word-break: break-word; background: #fffaf0; border: 1px solid var(--line); border-radius: 9px; padding: 10px; font-size: 13px; max-height: 320px; overflow: auto; }

  svg text { user-select: none; }
  .node { cursor: pointer; }
  .node rect.card { fill: #f7e9cd; stroke: #c4a877; stroke-width: 1.2; }
  .node.anchor rect.card { fill: #d9ebe2; stroke: var(--accent); stroke-width: 2; }
  .node.parent rect.card { stroke: #1d4ed8; }
  .node.child rect.card { stroke: #6d28d9; }
  .node.sibling rect.card { stroke: #7a6148; }
  .node.parent, .node.child, .node.sibling { opacity: .62; }
  .node.parent:hover, .node.child:hover, .node.sibling:hover { opacity: .95; }
  .node text.title { fill: #3a2b1c; font-size: 14px; font-weight: 600; }
  .node text.role { fill: #7a6148; font-size: 11px; letter-spacing: .05em; }
  .node .detailBtn { fill: #f7e9cd; stroke: #c4a877; }
  .node text.detailText { fill: #7a6148; font-size: 11px; }
  .node .handle { fill: #f7e9cd; stroke: var(--accent2); stroke-width: 1.4; }
  .node .handleText { fill: var(--accent); font-size: 13px; font-weight: 700; }
  .edge { stroke: #c4a877; stroke-width: 1.6; fill: none; marker-end: url(#arrow); }
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
      background: #f7e9cd; box-shadow: -24px 0 60px rgba(96, 62, 18, .30);
    }
    #detailResize { display: none; }
  }

  .relRow { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; flex-wrap: wrap; }
  .relLabel { color: var(--muted); font-size: 13px; width: 42px; flex: 0 0 auto; }
  .relPick { flex: 1; min-width: 0; border: 1px dashed var(--line2); border-radius: 8px; padding: 6px 9px; font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .relPick.set { border-style: solid; border-color: #2f6b4f; color: var(--text); }
  .relChoice { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text); margin-right: 12px; }
  .relResults { display: grid; gap: 7px; max-height: 260px; overflow: auto; margin-top: 9px; }
  .relResult { text-align: left; border: 1px solid var(--line); background: #f7e9cd; border-radius: 9px; padding: 8px 10px; }
  .relResult:hover { border-color: var(--line2); background: #f2e3c4; }
  .relResult b { font-size: 14px; }
  .relResult .muted { font-size: 12px; }
  .relCheck { border: 1px solid var(--line2); border-radius: 9px; padding: 9px 11px; font-size: 12.5px; margin-top: 11px; }
  .relCheck.ok { border-color: #2f6b4f; background: rgba(52, 211, 153, .08); color: var(--ok); }
  .relCheck.bad { border-color: #a8552a; background: rgba(248, 113, 113, .08); color: var(--danger); }
  .deletedRow { display: flex; align-items: center; gap: 7px; border: 1px solid var(--line); border-radius: 9px; padding: 7px 9px; margin-bottom: 7px; background: #f7e9cd; }
  .deletedRow .grow { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .deletedRow .tag { flex: 0 0 auto; }
  #detail .block h3 .grow { flex: 1; }
  /* Path view: the ordered flow of one saved favorite, shown over the canvas. */
  .pathView {
    position: absolute; inset: 18px; z-index: 20; overflow: auto;
    padding: 20px 22px; border-radius: 16px; border: 1px solid var(--line);
    background: rgba(251, 241, 220, .97); box-shadow: var(--shadow);
  }
  .pvHead { display: flex; align-items: center; gap: 10px; }
  .pvHead h3 { margin: 0; font-size: 17px; font-weight: 700; }
  .pvSummary { margin: 8px 0 14px; color: var(--muted); font-size: 13px; }
  .pvSteps { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  .pvStep { position: relative; padding-left: 18px; }
  .pvStep::before { content: ""; position: absolute; left: 6px; top: 30px; bottom: -8px; width: 2px; background: var(--line); }
  .pvStep:last-child::before { display: none; }
  .pvStepBtn {
    display: flex; gap: 12px; width: 100%; text-align: left; padding: 11px 13px;
    border-radius: 12px; border: 1px solid var(--line); background: var(--panel); color: var(--text);
  }
  .pvStepBtn:hover { border-color: var(--accent2); background: #fffaf0; }
  .pvIndex {
    flex: 0 0 28px; height: 28px; display: grid; place-items: center;
    border-radius: 999px; border: 1px solid var(--line);
    background: #e6efe4; color: var(--accent); font-weight: 700; font-size: 13px;
  }
  .pvBody { display: grid; gap: 3px; min-width: 0; }
  .pvBody b { font-size: 14px; }
  .pvDesc { color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
  .pvShots { color: var(--accent); font-size: 11.5px; }
  .pvStep.is-missing .pvStepBtn { border-color: var(--danger); background: #fbe9e3; }
  .checkBox { margin-top: 10px; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); }
  .checkLine { font-size: 12.5px; font-weight: 600; }
  .checkLine.ok { color: var(--ok); }
  .checkLine.bad { color: var(--danger); }
  .checkList { margin: 6px 0 0; padding-left: 18px; color: var(--danger); font-size: 12.5px; line-height: 1.6; }
  /* Left column: one block per library surface. */
  .sideBlock { border: 1px solid var(--line); border-radius: 12px; background: var(--panel); padding: 12px; margin-bottom: 12px; }
  .blockHead { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 14px; margin-bottom: 8px; }
  .blockHead.small { font-weight: 600; font-size: 12.5px; color: var(--muted); margin: 12px 0 6px; }
  .blockHint { font-weight: 500; font-size: 11.5px; color: var(--muted); }
  .searchForm { display: flex; gap: 6px; margin-bottom: 8px; }
  .searchForm input { flex: 1; min-width: 0; }
  .resultList { display: grid; gap: 5px; }
  .resultItem { display: grid; gap: 2px; text-align: left; padding: 8px 10px; border-radius: 9px; border: 1px solid var(--line); background: #fffaf0; color: var(--text); }
  .resultItem:hover { border-color: var(--accent2); }
  .riTitle { font-weight: 600; font-size: 13px; }
  .riMeta { font-size: 11px; color: var(--muted); }
  .riDesc { font-size: 11.5px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pvMeta { display: flex; gap: 8px; margin: 10px 0; }
  .pvMeta input { flex: 1; min-width: 0; }
  .pvStepRow { display: flex; align-items: center; gap: 8px; }
  .pvStepBtn { flex: 1; text-align: left; display: block; padding: 10px 12px; border-radius: 11px; border: 1px solid var(--line); background: var(--panel); color: var(--text); }
  .pvStepBtn:hover { border-color: var(--accent2); }
  .pvTools { display: flex; gap: 5px; flex: 0 0 auto; }
  .pvStep.is-empty { list-style: none; }
  .insertCols { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
  .insertCol h4 { margin: 0 0 6px; font-size: 13px; }
  .insertCol input { width: 100%; margin-bottom: 6px; }
  .insertList { display: grid; gap: 4px; max-height: 260px; overflow: auto; }
  .insertItem { text-align: left; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--line); background: #fffaf0; color: var(--text); font-size: 12.5px; }
  .insertItem.picked { border-color: var(--accent2); background: #e6efe4; font-weight: 600; }
  .insertFoot { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
  .insertFoot .muted { flex: 1; }
  .statGrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .stat { border: 1px solid var(--line); border-radius: 10px; padding: 14px; text-align: center; background: var(--panel); }
  .stat b { display: block; font-size: 22px; }
  .stat span { font-size: 12px; color: var(--muted); }
  .logRow { display: grid; gap: 2px; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--line); background: #fffaf0; }
  .aiNotes { border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; background: #eef4ec; font-size: 13px; line-height: 1.6; }
</style>
</head>
<body>
<header id="topbar">
  <div class="brand">
    <div class="logo">◈</div>
    <div>
      <div class="title">经验库</div>
      <div class="sub" id="libPath">节点库 · 路径收藏</div>
    </div>
  </div>
  <div class="topActions">
    <span class="dirtyFlag" id="dirtyFlag" hidden>● 未保存</span>
    <button class="btn" data-action="open-stats">统计看板</button>
    <button class="btn" data-action="new-path">+ 新建路径</button>
    <button class="btn primary" id="newBtn" data-action="new-node">+ 新建节点</button>
  </div>
</header>
<main>
  <aside id="side">
    <section class="sideBlock">
      <div class="blockHead">节点 <span class="grow"></span><span class="blockHint">查看 / 编辑</span></div>
      <form id="nodeSearchForm" autocomplete="off" class="searchForm">
        <input id="nodeSearchInput" placeholder="搜索节点关键词或描述" aria-label="搜索节点">
        <button class="btn" type="submit">搜索</button>
      </form>
      <div id="nodeSearchResults" class="resultList"><span class="muted">输入关键词搜索节点。</span></div>
      <div class="blockHead small">收藏节点 <span class="grow"></span><button class="btn small ghost" data-action="reload-favorites">刷新</button></div>
      <div id="nodeFavorites" class="resultList"><span class="muted">读取中…</span></div>
    </section>
    <section class="sideBlock">
      <div class="blockHead">路径 <span class="grow"></span><span class="blockHint">整条流程</span></div>
      <form id="pathSearchForm" autocomplete="off" class="searchForm">
        <input id="pathSearchInput" placeholder="搜索路径 / 整条流程" aria-label="搜索路径">
        <button class="btn" type="submit">搜索</button>
      </form>
      <div id="pathSearchResults" class="resultList"><span class="muted">输入关键词搜索路径。</span></div>
      <div class="blockHead small">收藏路径 <span class="grow"></span><button class="btn small ghost" data-action="reload-favorites">刷新</button></div>
      <div id="pathFavorites" class="resultList"><span class="muted">读取中…</span></div>
    </section>
    <section class="sideBlock">
      <div class="blockHead small">操作记录 <span class="grow"></span><button class="btn small ghost" data-action="refresh-log">刷新</button></div>
      <div id="logList" class="resultList"><span class="muted">还没有操作记录。</span></div>
    </section>
  </aside>
  <section id="stage">
    <div id="emptyHint">
      <div class="big">◇</div>
      <h2>从搜索开始</h2>
      <p>搜索一条路径查看整条流程，或搜索一个节点查看并修改它。</p>
    </div>
    <div id="pathView" class="pathView" hidden></div>
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
    settings: {},
    detail: null,
    detailDirty: false,
    pathEditor: null,
    pathDirty: false,
    insert: null,
    nodes: [],
    paths: [],
    titles: {},
    log: []
  };
  var toastTimer = null;

  function $(id) { return document.getElementById(id); }
  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (ch) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch];
    });
  }
  function show(el, yes) { if (el) el.hidden = !yes; }
  function formatTs(ts) { return String(ts == null ? "" : ts).slice(0, 19).replace("T", " "); }
  function statusLabel(status) { return status === "deleted" ? "已删除" : "在用"; }
  function toast(message, kind) {
    var el = $("toast");
    el.textContent = message;
    el.className = kind || "";
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2800);
  }
  function api(path, options) {
    var opts = options || {};
    var init = { method: opts.method || "GET", headers: { "content-type": "application/json" } };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    return fetch(BASE + path, init).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (error) { data = null; }
        if (!response.ok) {
          var message = data && data.error && data.error.message ? data.error.message : "请求失败（" + response.status + "）";
          throw new Error(message);
        }
        return data;
      });
    });
  }

  // ---------- modal ----------
  function showModal(title, bodyHtml, footHtml) {
    $("modalTitle").textContent = title;
    $("modalBody").innerHTML = bodyHtml;
    $("modalFoot").innerHTML = footHtml || "";
    $("modalRoot").hidden = false;
  }
  function closeModal() { $("modalRoot").hidden = true; $("modalBody").innerHTML = ""; $("modalFoot").innerHTML = ""; }
  function askConfirm(options) {
    return new Promise(function (resolve) {
      showModal(options.title || "确认", "<p>" + esc(options.message || "") + "</p>",
        '<button class="btn ghost" data-confirm="no">取消</button>'
        + (options.danger ? '<button class="btn danger" data-confirm="yes">' + esc(options.confirmText || "删除") + '</button>'
          : '<button class="btn primary" data-confirm="yes">' + esc(options.confirmText || "确定") + '</button>'));
      $("modalFoot").addEventListener("click", function handler(event) {
        var button = event.target.closest ? event.target.closest("[data-confirm]") : null;
        if (!button) return;
        $("modalFoot").removeEventListener("click", handler);
        var yes = button.getAttribute("data-confirm") === "yes";
        closeModal();
        resolve(yes);
      });
    });
  }

  // ---------- node detail (view + edit) ----------
  function openDetail(id) {
    return api("/api/nodes/" + encodeURIComponent(id)).then(function (detail) {
      renderDetail(detail);
      return detail;
    }).catch(function (error) { toast(error.message, "bad"); });
  }
  function renderDetail(detail) {
    state.detail = detail;
    var node = detail.node;
    var deleted = node.status === "deleted";
    state.titles[node.id] = node.title;
    var drawer = $("detail");
    var html = '<div id="detailResize" title="拖动调整宽度"></div>';
    html += '<div class="row"><h2 class="grow">' + esc(node.title || "未命名节点") + '</h2>'
      + '<span class="tag ' + (deleted ? "bad" : "ok") + '">' + esc(statusLabel(node.status)) + '</span>'
      + '<button class="btn small ghost" data-action="close-detail">关闭</button></div>';
    html += '<div class="meta">创建人 ' + esc(node.created_by) + ' · ' + esc(formatTs(node.created_at)) + '</div>';
    html += '<div class="field"><label>标题</label><input id="detailTitle" value="' + esc(node.title) + '"></div>';
    html += '<div class="field"><label>说明（人写的打底，执行时先读它）</label><textarea id="detailDesc" rows="6">' + esc(node.description) + '</textarea></div>';
    html += '<div class="field"><label>AI 自动补充（执行时优先参考）</label>'
      + (node.ai_notes ? '<div class="aiNotes">' + esc(node.ai_notes).replace(/\n/g, '<br>') + '</div>'
        + '<div class="muted" style="font-size:11px;margin-top:4px">更新于 ' + esc(formatTs(node.ai_updated_at || "")) + '，只由模型写入，人写的说明不会被改。</div>'
        : '<div class="hintBox">还没有 AI 补充；按这个节点执行过后，模型会把它学到的坑和更好的提示写进来。</div>')
      + '</div>';
    html += '<div class="actionGrid"><button class="btn primary wide" data-action="save-node" data-id="' + esc(node.id) + '">保存修改</button></div>';
    var humanShots = detail.screenshots.filter(function (shot) { return shot.source !== "ai"; });
    var aiShots = detail.screenshots.filter(function (shot) { return shot.source === "ai"; });
    html += '<div class="block"><h3>人的截图（核心评判标准）</h3><div class="shots">';
    if (humanShots.length === 0) html += '<span class="muted">还没有人的截图。</span>';
    humanShots.forEach(function (shot) {
      html += '<figure class="shot"><img src="' + esc(BASE + "/" + shot.url) + '" alt="' + esc(shot.caption) + '" loading="lazy">'
        + '<figcaption><span class="grow">' + esc(shot.caption) + '</span><button class="btn small danger" data-action="delete-shot" data-id="' + esc(node.id) + '" data-shot="' + esc(shot.id) + '">删</button></figcaption></figure>';
    });
    html += '</div><div class="row" style="margin-top:8px"><input type="file" id="shotFile" accept="image/png,image/jpeg,image/webp,image/gif" style="flex:1"></div>'
      + '<div class="row" style="margin-top:6px"><input id="shotCaption" class="grow" placeholder="这句截图说明用来校验准确性"><button class="btn small" data-action="upload-shot" data-id="' + esc(node.id) + '">上传</button></div>'
      + '<h3 style="margin-top:12px">AI 截图（执行指导）</h3><div class="shots">';
    if (aiShots.length === 0) html += '<span class="muted">还没有 AI 截图。</span>';
    aiShots.forEach(function (shot) {
      html += '<figure class="shot"><img src="' + esc(BASE + "/" + shot.url) + '" alt="' + esc(shot.caption) + '" loading="lazy">'
        + '<figcaption><span class="grow">' + esc(shot.caption) + '</span><button class="btn small danger" data-action="delete-shot" data-id="' + esc(node.id) + '" data-shot="' + esc(shot.id) + '">删</button></figcaption></figure>';
    });
    html += '</div></div>';
    html += '<div class="block"><h3>被这些路径引用</h3>';
    if (detail.paths.length === 0) html += '<span class="muted">没有路径引用它。</span>';
    detail.paths.forEach(function (path) {
      html += '<div class="edgeRow"><span class="grow">' + esc(path.name) + ' <span class="tag ' + (path.runnable ? "ok" : "bad") + '">' + (path.runnable ? "完整" : "有问题") + '</span></span>'
        + '<button class="btn small" data-action="open-path" data-id="' + esc(path.id) + '">查看路径</button></div>';
    });
    html += '</div>';
    html += '<div class="block"><h3>节点操作</h3><div class="actionGrid">'
      + '<button class="btn wide" data-action="copy-node" data-id="' + esc(node.id) + '">复制节点</button>';
    if (deleted) {
      html += '<button class="btn primary wide" data-action="restore-node" data-id="' + esc(node.id) + '">恢复节点</button>';
    } else {
      html += '<button class="btn danger wide" data-action="delete-node" data-id="' + esc(node.id) + '">删除节点</button>';
    }
    html += '</div><div class="muted" style="font-size:11px;margin-top:7px">删除是软删除，需要时在节点搜索里找回并恢复。</div></div>';
    drawer.innerHTML = html;
    drawer.hidden = false;
    bindDrawerResize();
  }
  function hideDetail() { $("detail").hidden = true; $("detail").innerHTML = ""; state.detail = null; }
  function bindDrawerResize() {
    var handle = $("detailResize");
    var drawer = $("detail");
    if (!handle || !drawer || handle.getAttribute("data-bound") === "1") return;
    handle.setAttribute("data-bound", "1");
    var active = false;
    var startX = 0;
    var startWidth = 0;
    handle.addEventListener("pointerdown", function (event) {
      active = true;
      startX = event.clientX;
      startWidth = drawer.getBoundingClientRect().width;
      handle.classList.add("active");
      event.preventDefault();
    });
    handle.addEventListener("pointermove", function (event) {
      if (!active) return;
      var width = Math.min(Math.max(320, startWidth - (event.clientX - startX)), Math.min(760, window.innerWidth * 0.6));
      drawer.style.setProperty("--drawer-width", width + "px");
    });
    var stop = function () { active = false; handle.classList.remove("active"); };
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  // ---------- search ----------
  function renderNodeRow(node) {
    var deleted = node.status === "deleted";
    return '<button class="resultItem" data-action="open-node" data-id="' + esc(node.id) + '">'
      + '<span class="riTitle">' + esc(node.title || "未命名节点") + '</span>'
      + '<span class="riMeta">' + (deleted ? '<span class="tag bad">已删除</span>' : "<span class=\"tag ok\">在用</span>") + '</span>'
      + '</button>';
  }
  function renderPathRow(path) {
    return '<button class="resultItem" data-action="open-path" data-id="' + esc(path.id) + '">'
      + '<span class="riTitle">' + esc(path.name || "未命名路径") + '</span>'
      + '<span class="riMeta">' + (path.node_count == null ? "" : path.node_count + " 步") + '</span>'
      + (path.summary ? '<span class="riDesc">' + esc(path.summary) + '</span>' : "")
      + '</button>';
  }
  function searchNodes() {
    var query = $("nodeSearchInput").value.trim();
    var box = $("nodeSearchResults");
    if (!query) { box.innerHTML = '<span class="muted">输入关键词搜索节点。</span>'; return; }
    box.innerHTML = '<span class="muted">搜索中…</span>';
    api("/api/search?q=" + encodeURIComponent(query) + "&threshold=" + encodeURIComponent(String(state.settings.searchThreshold == null ? 0.6 : state.settings.searchThreshold))).then(function (data) {
      var seen = {};
      var rows = [];
      (data.candidates || []).concat(data.keyword || []).forEach(function (candidate) {
        var node = candidate.node;
        if (!node || seen[node.id]) return;
        seen[node.id] = true;
        rows.push(renderNodeRow(node));
      });
      box.innerHTML = rows.length === 0 ? '<span class="muted">没有找到节点。</span>' : rows.join("");
    }).catch(function (error) { box.innerHTML = '<span class="muted">搜索失败：' + esc(error.message) + '</span>'; });
  }
  function searchPaths() {
    var query = $("pathSearchInput").value.trim();
    var box = $("pathSearchResults");
    if (!query) { box.innerHTML = '<span class="muted">输入关键词搜索路径。</span>'; return; }
    box.innerHTML = '<span class="muted">搜索中…</span>';
    api("/api/index/match?q=" + encodeURIComponent(query) + "&threshold=" + encodeURIComponent(String(state.settings.searchThreshold == null ? 0.6 : state.settings.searchThreshold))).then(function (data) {
      var seen = {};
      var rows = [];
      (data.candidates || []).concat(data.keyword || []).forEach(function (candidate) {
        var path = candidate.path || candidate;
        if (!path || !path.id || seen[path.id]) return;
        seen[path.id] = true;
        rows.push(renderPathRow(path));
      });
      box.innerHTML = rows.length === 0 ? '<span class="muted">没有找到路径。</span>' : rows.join("");
    }).catch(function (error) { box.innerHTML = '<span class="muted">搜索失败：' + esc(error.message) + '</span>'; });
  }
  function loadFavorites() {
    return Promise.all([api("/api/nodes?status=active"), api("/api/paths")]).then(function (data) {
      state.nodes = data[0].nodes || [];
      state.paths = data[1].paths || [];
      var nodeBox = $("nodeFavorites");
      nodeBox.innerHTML = state.nodes.length === 0 ? '<span class="muted">还没有节点。</span>' : state.nodes.map(function (node) {
        return '<button class="resultItem" data-action="open-node" data-id="' + esc(node.id) + '"><span class="riTitle">' + esc(node.title || "未命名节点") + '</span></button>';
      }).join("");
      var pathBox = $("pathFavorites");
      pathBox.innerHTML = state.paths.length === 0 ? '<span class="muted">还没有路径。</span>' : state.paths.map(function (path) {
        return '<button class="resultItem" data-action="open-path" data-id="' + esc(path.id) + '"><span class="riTitle">' + esc(path.name || "未命名路径") + '</span><span class="riMeta">' + (path.node_count == null ? "" : path.node_count + " 步") + '</span></button>';
      }).join("");
    }).catch(function (error) { toast(error.message, "bad"); });
  }

  // ---------- path editor ----------
  function newPath() {
    state.pathEditor = { pathId: null, name: "未命名路径", summary: "", steps: [] };
    state.pathDirty = true;
    renderPathEditor();
  }
  function openPath(id) {
    api("/api/paths/" + encodeURIComponent(id)).then(function (detail) {
      var path = detail.path;
      state.pathEditor = { pathId: path.id, name: path.name, summary: path.summary, steps: (path.node_sequence || []).slice() };
      state.pathDirty = false;
      (detail.nodes || []).forEach(function (node) { state.titles[node.id] = node.title; });
      renderPathEditor();
    }).catch(function (error) { toast(error.message, "bad"); });
  }
  function stepHtml(nodeId, index) {
    var node = state.titles[nodeId] === undefined ? null : null;
    var title = state.titles[nodeId] || nodeId;
    return '<li class="pvStep">'
      + '<div class="pvStepRow">'
      + '<span class="pvIndex">' + (index + 1) + '</span>'
      + '<button class="pvStepBtn" data-action="open-node" data-id="' + esc(nodeId) + '"><b>' + esc(title) + '</b></button>'
      + '<span class="pvTools">'
      + '<button class="btn small" title="在前面插入" data-action="insert-step" data-index="' + index + '" data-dir="before">前 +</button>'
      + '<button class="btn small" title="在后面插入" data-action="insert-step" data-index="' + index + '" data-dir="after">后 +</button>'
      + '<button class="btn small danger" data-action="remove-step" data-index="' + index + '">删</button>'
      + '</span></div></li>';
  }
  function renderPathEditor() {
    var editor = state.pathEditor;
    var view = $("pathView");
    // Step rows render titles from the node cache; the favorites list carries every live title.
    state.nodes.forEach(function (node) { state.titles[node.id] = node.title; });
    var html = '<div class="pvHead"><h3>' + esc(editor.name || "未命名路径") + '</h3>'
      + '<span class="tag ' + (state.pathDirty ? "warn" : "ok") + '">' + (state.pathDirty ? "未保存" : "已保存") + '</span>'
      + '<span class="grow"></span>'
      + '<button class="btn small" data-action="check-path-editor">检查</button>'
      + '<button class="btn small primary" data-action="save-path-editor">保存</button>'
      + '<button class="btn small ghost" data-action="close-path-editor">关闭</button></div>';
    html += '<div class="pvMeta">'
      + '<input id="pathNameInput" value="' + esc(editor.name) + '" placeholder="路径名">'
      + '<input id="pathSummaryInput" value="' + esc(editor.summary) + '" placeholder="路径摘要（检索时读它）">'
      + '</div>';
    html += '<div id="pathCheck" class="checkBox" hidden></div>';
    html += '<ol class="pvSteps">';
    if (editor.steps.length === 0) {
      html += '<li class="pvStep is-empty"><button class="btn" data-action="insert-step" data-index="0" data-dir="before">+ 添加第一个节点</button></li>';
    } else {
      editor.steps.forEach(function (nodeId, index) { html += stepHtml(nodeId, index); });
      html += '<li class="pvStep"><button class="btn" data-action="insert-step" data-index="' + (editor.steps.length - 1) + '" data-dir="after">+ 在末尾添加</button></li>';
    }
    html += '</ol>';
    view.innerHTML = html;
    view.hidden = false;
    $("emptyHint").hidden = true;
  }
  function closePathEditor() {
    state.pathEditor = null;
    state.pathDirty = false;
    $("pathView").hidden = true;
    $("pathView").innerHTML = "";
    $("emptyHint").hidden = false;
  }
  function insertStep(index, direction) {
    state.insert = { index: Number(index), direction: direction };
    var body = '<div class="insertCols">'
      + '<div class="insertCol"><h4>本路径内节点</h4><div id="insertLocal" class="insertList"></div></div>'
      + '<div class="insertCol"><h4>搜索节点</h4><input id="insertQuery" placeholder="关键词"><button class="btn small" data-action="insert-search">搜索</button><div id="insertResults" class="insertList"></div></div>'
      + '<div class="insertCol"><h4>收藏节点</h4><div id="insertFavorites" class="insertList"></div></div>'
      + '</div>'
      + '<div class="insertFoot"><span id="insertPicked" class="muted">选一个节点</span><button class="btn primary" data-action="insert-apply" disabled id="insertApplyBtn">插入</button></div>';
    showModal("插入节点（" + (direction === "before" ? "前面" : "后面") + "）", body);
    var local = state.pathEditor.steps.map(function (id) { return { id: id, title: state.titles[id] || id }; });
    $("insertLocal").innerHTML = local.length === 0 ? '<span class="muted">路径还没有节点。</span>' : local.map(function (entry) {
      return '<button class="insertItem" data-pick-node="' + esc(entry.id) + '">' + esc(entry.title) + '</button>';
    }).join("");
    $("insertFavorites").innerHTML = state.nodes.length === 0 ? '<span class="muted">还没有节点。</span>' : state.nodes.map(function (node) {
      return '<button class="insertItem" data-pick-node="' + esc(node.id) + '">' + esc(node.title || "未命名节点") + '</button>';
    }).join("");
    bindInsertPicker();
  }
  function bindInsertPicker() {
    var root = $("modalBody");
    // modalBody survives between dialogs, so bind the picker only once.
    if (root.getAttribute("data-picker") === "1") return;
    root.setAttribute("data-picker", "1");
    root.addEventListener("click", function handler(event) {
      var pick = event.target.closest ? event.target.closest("[data-pick-node]") : null;
      if (!pick) return;
      root.querySelectorAll(".insertItem.picked").forEach(function (item) { item.classList.remove("picked"); });
      pick.classList.add("picked");
      state.insert.picked = pick.getAttribute("data-pick-node");
      $("insertPicked").textContent = "已选：" + (state.titles[state.insert.picked] || state.insert.picked);
      $("insertApplyBtn").disabled = false;
    });
  }
  function insertSearch() {
    var query = $("insertQuery").value.trim();
    if (!query) return;
    $("insertResults").innerHTML = '<span class="muted">搜索中…</span>';
    api("/api/search?q=" + encodeURIComponent(query) + "&threshold=" + encodeURIComponent(String(state.settings.searchThreshold == null ? 0.6 : state.settings.searchThreshold))).then(function (data) {
      var seen = {};
      var rows = [];
      (data.candidates || []).concat(data.keyword || []).forEach(function (candidate) {
        var node = candidate.node;
        if (!node || seen[node.id]) return;
        seen[node.id] = true;
        state.titles[node.id] = node.title;
        rows.push('<button class="insertItem" data-pick-node="' + esc(node.id) + '">' + esc(node.title || "未命名节点") + '</button>');
      });
      $("insertResults").innerHTML = rows.length === 0 ? '<span class="muted">没有结果。</span>' : rows.join("");
    }).catch(function (error) { $("insertResults").innerHTML = '<span class="muted">失败：' + esc(error.message) + '</span>'; });
  }
  function applyInsert() {
    var insert = state.insert;
    if (!insert || !insert.picked) return;
    var steps = state.pathEditor.steps;
    if (steps.indexOf(insert.picked) !== -1) { toast("这个节点已经在路径里，重复插入会形成环。", "bad"); return; }
    var at = insert.direction === "before" ? insert.index : insert.index + 1;
    steps.splice(at, 0, insert.picked);
    state.pathDirty = true;
    closeModal();
    renderPathEditor();
    toast("已插入「" + (state.titles[insert.picked] || insert.picked) + "」。");
  }
  function removeStep(index) {
    state.pathEditor.steps.splice(Number(index), 1);
    state.pathDirty = true;
    renderPathEditor();
  }
  function savePathEditor() {
    var editor = state.pathEditor;
    if (!editor) return;
    editor.name = $("pathNameInput").value.trim() || "未命名路径";
    editor.summary = $("pathSummaryInput").value.trim();
    if (editor.steps.length === 0) { toast("路径至少需要一个节点。", "warn"); return; }
    var body = { name: editor.name, summary: editor.summary, node_sequence: editor.steps };
    var request = editor.pathId == null
      ? api("/api/paths", { method: "POST", body: body })
      : api("/api/paths/" + encodeURIComponent(editor.pathId), { method: "PUT", body: body });
    request.then(function (data) {
      editor.pathId = data.path.id;
      state.pathDirty = false;
      toast("路径已保存。");
      loadFavorites();
      renderPathEditor();
    }).catch(function (error) { toast(error.message, "bad"); });
  }
  function checkPathEditor() {
    var editor = state.pathEditor;
    var box = $("pathCheck");
    if (!editor || !box) return;
    function showCheck(result) {
      if (!result.issues || result.issues.length === 0) {
        box.innerHTML = '<div class="checkLine ok">检查通过：' + editor.steps.length + ' 个步骤，节点都在。</div>';
      } else {
        box.innerHTML = '<div class="checkLine bad">发现 ' + result.issues.length + ' 个问题：</div><ul class="checkList">'
          + result.issues.map(function (issue) { return '<li>' + esc(issue.message) + '</li>'; }).join("") + '</ul>';
      }
      box.hidden = false;
    }
    if (editor.steps.length === 0) {
      showCheck({ issues: [{ message: "路径里还没有节点。" }] });
      return;
    }
    var dup = {};
    var repeated = null;
    editor.steps.forEach(function (id) { if (dup[id]) repeated = id; dup[id] = true; });
    if (repeated) {
      showCheck({ issues: [{ message: "节点「" + (state.titles[repeated] || repeated) + "」重复出现，形成环。" }] });
      return;
    }
    if (editor.pathId != null) {
      api("/api/paths/" + encodeURIComponent(editor.pathId) + "/check").then(function (data) { showCheck(data.check); }).catch(function (error) { toast(error.message, "bad"); });
    } else {
      var missing = editor.steps.filter(function (id) { return state.titles[id] === undefined && !state.nodes.some(function (node) { return node.id === id; }); });
      if (missing.length > 0) {
        showCheck({ issues: missing.map(function (id) { return { message: "节点 " + id + " 不存在。" }; }) });
      } else {
        showCheck({ issues: [] });
      }
    }
  }

  // ---------- stats ----------
  function openStats() {
    api("/api/stats").then(function (data) {
      var stats = data.stats || {};
      var counts = stats.counts || {};
      var html = '<div class="statGrid">'
        + '<div class="stat"><b>' + (counts.nodes || 0) + '</b><span>节点</span></div>'
        + '<div class="stat"><b>' + (counts.paths || 0) + '</b><span>路径</span></div>'
        + '<div class="stat"><b>' + (counts.decisions || 0) + '</b><span>操作记录</span></div>'
        + '</div>';
      showModal("统计看板", html, '<button class="btn" data-action="close-modal">关闭</button>');
    }).catch(function (error) { toast(error.message, "bad"); });
  }

  // ---------- log ----------
  function loadLog() {
    api("/api/log?limit=60").then(function (data) {
      var rows = data.entries || [];
      $("logList").innerHTML = rows.length === 0 ? '<span class="muted">还没有操作记录。</span>' : rows.map(function (entry) {
        return '<div class="logRow"><span class="riTitle">' + esc(entry.sentence || entry.action_label || "") + '</span>'
          + '<span class="riDesc">' + esc(formatTs(entry.ts)) + '</span></div>';
      }).join("");
    }).catch(function (error) { $("logList").innerHTML = '<span class="muted">读取失败：' + esc(error.message) + '</span>'; });
  }

  // ---------- create node ----------
  function openCreate() {
    showModal("新建节点",
      '<div class="field"><label>标题</label><input id="createTitle" placeholder="例如：进入天翼云电脑"></div>'
      + '<div class="field"><label>说明（步骤正文，检索和模型都读它）</label><textarea id="createDesc" rows="6" placeholder="先做什么，再做什么，成功判据是什么"></textarea></div>',
      '<button class="btn ghost" data-action="close-modal">取消</button><button class="btn primary" data-action="create-node-apply">创建</button>');
  }
  function createNodeApply() {
    var title = $("createTitle").value.trim();
    if (!title) { toast("标题不能为空。", "warn"); return; }
    api("/api/nodes", { method: "POST", body: { title: title, description: $("createDesc").value } }).then(function (data) {
      closeModal();
      toast("节点已创建。");
      loadFavorites();
      return openDetail(data.node.id);
    }).catch(function (error) { toast(error.message, "bad"); });
  }

  // ---------- events ----------
  function actionOf(target) { return target && target.closest ? target.closest("[data-action]") : null; }
  document.addEventListener("click", function (event) {
    var el = actionOf(event.target);
    if (!el) return;
    var action = el.getAttribute("data-action");
    var id = el.getAttribute("data-id");
    if (action === "open-node") { event.preventDefault(); openDetail(id); return; }
    if (action === "open-path") { event.preventDefault(); openPath(id); return; }
    if (action === "close-detail") { hideDetail(); return; }
    if (action === "new-node") { openCreate(); return; }
    if (action === "new-path") { newPath(); return; }
    if (action === "open-stats") { openStats(); return; }
    if (action === "refresh-log") { loadLog(); return; }
    if (action === "reload-favorites") { loadFavorites(); return; }
    if (action === "close-modal") { closeModal(); return; }
    if (action === "create-node-apply") { createNodeApply(); return; }
    if (action === "close-path-editor") { closePathEditor(); return; }
    if (action === "save-path-editor") { savePathEditor(); return; }
    if (action === "check-path-editor") { checkPathEditor(); return; }
    if (action === "insert-step") { event.preventDefault(); insertStep(el.getAttribute("data-index"), el.getAttribute("data-dir")); return; }
    if (action === "remove-step") { event.preventDefault(); removeStep(el.getAttribute("data-index")); return; }
    if (action === "insert-search") { event.preventDefault(); insertSearch(); return; }
    if (action === "insert-apply") { event.preventDefault(); applyInsert(); return; }
    if (action === "save-node") {
      event.preventDefault();
      api("/api/nodes/" + encodeURIComponent(id), { method: "PATCH", body: { title: $("detailTitle").value, description: $("detailDesc").value } }).then(function (data) {
        toast("已保存。");
        state.titles[data.node.id] = data.node.title;
        loadFavorites();
        return openDetail(id);
      }).catch(function (error) { toast(error.message, "bad"); });
      return;
    }
    if (action === "delete-node") {
      event.preventDefault();
      askConfirm({ title: "删除节点？", message: "删除是软删除：节点和它的截图留在库里，只是不再出现在搜索和路径里。", confirmText: "删除", danger: true }).then(function (yes) {
        if (!yes) return;
        api("/api/nodes/" + encodeURIComponent(id) + "/delete", { method: "POST", body: {} }).then(function () {
          toast("节点已删除。");
          hideDetail();
          loadFavorites();
        }).catch(function (error) { toast(error.message, "bad"); });
      });
      return;
    }
    if (action === "restore-node") {
      event.preventDefault();
      api("/api/nodes/" + encodeURIComponent(id) + "/restore", { method: "POST", body: {} }).then(function () {
        toast("已恢复。");
        loadFavorites();
        return openDetail(id);
      }).catch(function (error) { toast(error.message, "bad"); });
      return;
    }
    if (action === "copy-node") {
      event.preventDefault();
      api("/api/nodes/" + encodeURIComponent(id) + "/copy", { method: "POST", body: {} }).then(function (data) {
        toast("副本已创建。");
        loadFavorites();
        return openDetail(data.node.id);
      }).catch(function (error) { toast(error.message, "bad"); });
      return;
    }
    if (action === "delete-shot") {
      event.preventDefault();
      api("/api/nodes/" + encodeURIComponent(id) + "/screenshots/" + encodeURIComponent(el.getAttribute("data-shot")), { method: "DELETE" }).then(function () {
        toast("截图已删除。");
        return openDetail(id);
      }).catch(function (error) { toast(error.message, "bad"); });
      return;
    }
    if (action === "upload-shot") {
      event.preventDefault();
      var input = $("shotFile");
      var file = input && input.files ? input.files[0] : null;
      if (!file) { toast("先选择一张图片。", "warn"); return; }
      var caption = $("shotCaption").value.trim();
      var reader = new FileReader();
      reader.onload = function () {
        api("/api/nodes/" + encodeURIComponent(id) + "/screenshots", { method: "POST", body: { caption: caption, data: String(reader.result), file_name: file.name } }).then(function () {
          toast("截图已上传。");
          return openDetail(id);
        }).catch(function (error) { toast(error.message, "bad"); });
      };
      reader.readAsDataURL(file);
      return;
    }
  });
  $("nodeSearchForm").addEventListener("submit", function (event) { event.preventDefault(); searchNodes(); });
  $("pathSearchForm").addEventListener("submit", function (event) { event.preventDefault(); searchPaths(); });
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") { if (!$("modalRoot").hidden) closeModal(); }
  });

  api("/api/state").then(function (data) {
    state.settings = data.settings || {};
    $("libPath").textContent = data.dir;
    $("libPath").title = data.dir;
  }).catch(function () {});
  loadFavorites();
  loadLog();
})();
</script>
</body>
</html>`
