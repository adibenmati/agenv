// util.js — shared helpers

let _token = "";
export function setToken(t) { _token = t; }
export function getToken() { return _token; }

export function api(p) {
  return p + (p.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(_token);
}

export function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function ago(ts) {
  if (!ts) return "";
  var d = (Date.now() - ts) / 1000;
  if (d < 60) return "now";
  if (d < 3600) return Math.floor(d / 60) + "m";
  if (d < 86400) return Math.floor(d / 3600) + "h";
  return Math.floor(d / 86400) + "d";
}

export function short(p) {
  if (!p) return "~";
  var s = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return s.length > 2 ? "../" + s.slice(-2).join("/") : p;
}

export function fname(p) {
  if (!p) return "";
  return p.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "";
}

export function tIcon(t) {
  return { claude: "C", vertex: "V", gcloud: "G", aws: "A", azure: "Az", ssh: "S", docker: "D", k8s: "K", python: "Py", node: "N", npm: "n", git: "G", terminal: ">" }[t] || ">";
}

export function $(id) { return document.getElementById(id); }

let _nextId = 1;
export function uid(prefix) { return (prefix || "id") + "-" + (_nextId++); }
