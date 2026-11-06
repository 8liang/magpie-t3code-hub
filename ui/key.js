// Settings panel: shows the hub address and management key T3 Code asks for.
//
// A panel can't fetch or read files (connect-src 'none'); it can only read
// and write this plugin's own options in plugins.json. So the key it shows
// is the `managementKey` option, which the hub prefers over its token file.
// Without one, "Generate" saves a new key there; Magpie then restarts the
// plugin host and the hub serves that key.

const zh = () => (magpie.theme?.lang || navigator.language || "").toLowerCase().startsWith("zh");
const T = {
  address: ["Hub address", "Hub 地址"],
  key: ["Management key", "Management key"],
  copy: ["Copy", "复制"],
  copied: ["Copied", "已复制"],
  show: ["Show", "显示"],
  hide: ["Hide", "隐藏"],
  howto: [
    "In T3 Code: Settings → Providers → Usage providers → Add a CLIProxyAPI hub, and enter these two values.",
    "在 T3 Code 中打开 Settings → Providers → Usage providers → Add a CLIProxyAPI hub，填入上面两项。",
  ],
  none: [
    "No key is saved in this plugin's options yet. The hub is using the key in its token file, which this panel can't read.",
    "插件选项里还没有保存 key。Hub 目前用的是 token 文件里的 key，面板读不到它。",
  ],
  generate: ["Generate a key", "生成 key"],
  generateNote: [
    "Saves a new key in the plugin's options and restarts the plugin host. If T3 Code already uses the old key, update it there.",
    "会在插件选项里保存一个新 key，并重启插件宿主。如果 T3 Code 里已经填过旧 key，需要改成新的。",
  ],
  saved: ["Saved. The hub restarts with this key in a few seconds.", "已保存。Hub 会在几秒内用这个 key 重启。"],
  failed: ["Couldn't save: ", "保存失败："],
};
const t = (k) => T[k][zh() ? 1 : 0];

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

async function copy(input, button) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(input.dataset.value);
    ok = true;
  } catch {
    // A sandboxed frame may not get the clipboard: select it for ⌘C instead.
    const type = input.type;
    input.type = "text";
    input.value = input.dataset.value;
    input.select();
    try { ok = document.execCommand("copy"); } catch {}
    if (type === "password") setTimeout(() => { input.type = "password"; }, 4000);
  }
  if (ok) {
    button.textContent = t("copied");
    setTimeout(() => { button.textContent = t("copy"); }, 1500);
  }
}

function field(label, value, secret) {
  const input = el("input", { readOnly: true, type: secret ? "password" : "text", value });
  input.dataset.value = value;
  input.addEventListener("focus", () => input.select());
  const copyBtn = el("button", { type: "button", textContent: t("copy") });
  copyBtn.addEventListener("click", () => copy(input, copyBtn));
  const toggle = secret
    ? el("button", { type: "button", textContent: t("show") })
    : el("span");
  if (secret) {
    toggle.addEventListener("click", () => {
      const hidden = input.type === "password";
      input.type = hidden ? "text" : "password";
      toggle.textContent = hidden ? t("hide") : t("show");
    });
  }
  return el("div", { className: "row" }, el("label", { textContent: label }), input, copyBtn, toggle);
}

function newKey() {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let out = "mgt_";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");

async function render() {
  const app = document.getElementById("app");
  let opts = {};
  try {
    opts = (await magpie.options.get()) || {};
  } catch {}
  const host = text(opts.host) || "127.0.0.1";
  const port = Number(opts.port) > 0 ? Number(opts.port) : 4319;
  const key = text(opts.managementKey) || text(opts.token);
  const shownHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const address = `http://${shownHost.includes(":") ? `[${shownHost}]` : shownHost}:${port}`;

  const parts = [field(t("address"), address, false)];
  if (key) {
    parts.push(field(t("key"), key, true), el("p", { className: "note", textContent: t("howto") }));
  } else {
    const status = el("p", { className: "note" });
    const gen = el("button", { type: "button", textContent: t("generate") });
    gen.addEventListener("click", async () => {
      gen.disabled = true;
      try {
        await magpie.options.set({ ...opts, managementKey: newKey() });
        await render();
        app.append(el("p", { className: "note ok", textContent: t("saved") }));
      } catch (e) {
        gen.disabled = false;
        status.textContent = t("failed") + (e?.message || String(e));
      }
    });
    parts.push(
      el("p", { className: "muted", textContent: t("none") }),
      el("div", {}, gen),
      el("p", { className: "note", textContent: t("generateNote") }),
      status,
    );
  }
  app.replaceChildren(...parts);
}

// A classic script (the bridge's own example is one too): no top-level await.
(async () => {
  await magpie.ready;
  await render();
  if (typeof magpie.onTheme === "function") magpie.onTheme(() => render());
})();
