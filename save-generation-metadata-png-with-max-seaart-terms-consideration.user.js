// ==UserScript==
// @name        SeaArt規約配慮MAXで生成情報入りPNG保存(Ver.0.1.9)
// @namespace   local.save.generation.metadata.png.with.max.seaart.terms.consideration
// @version     0.1.9
// @description 創作画面の画像生成物(1枚)のℹ️を押して生成情報を開いてる状態で、生成情報入りPNGを作って保存する。
// @match       https://www.seaart.ai/*
// @match       https://seaart.ai/*
// @run-at      document-idle
// @inject-into content
// @grant       GM_xmlhttpRequest
// @grant       GM.xmlHttpRequest
// @noframes
// ==/UserScript==

// SPDX-License-Identifier: CC0-1.0

// SeaArtの利用規約を最大限に尊重する為、画像1枚を生成情報入りPNGとして保存する以外の機能は一切ない。ウェブページ上での自動操作は一切しない。サーバーに反復的にリクエストするような、負荷を強いるような挙動は一切しない。
// スクリプト自身が通信しているのは、画面に出ている画像のURLへHTTPSでGETするところだけ。
// スクリプト自身はCookieヘッダもプロンプトも付けない。Userscriptsが画像ホストのcookieを添える余地はある。new Image() は、受け取った画像を端末内の blob として開いているだけで、別の通信ではない。保存の共有シートも、スクリプトからサーバーへ送る処理ではない。

(function () {
  "use strict";

  const VERSION = "0.1.9";
  const PANEL_ID = "save-generation-metadata-png-with-max-seaart-terms-consideration";
  const LABELS = ["プロンプト", "ネガティブプロンプト", "創作タイプ", "作成日時", "画像サイズ", "シード", "サンプラー", "スケジューラー", "ステップ", "CFGスケール", "Clip Skip"];
  const CRC = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    CRC[n] = c >>> 0;
  }

  let panel;
  let bodyNode;
  let statusNode;
  let launcher;
  let expanded = false;
  let busy = false;

  // 創作画面のときだけ真。
  function onCreatePage() {
    return /\/create(\/|$)/.test(location.pathname);
  }

  // パネルを開いた直後の2行。
  function initialStatus() {
    return "Ver." + VERSION + "\nℹ️を開いてから実行";
  }

  // パネルの文言を差し替える。
  function showStatus(text) {
    if (statusNode) statusNode.textContent = text;
  }

  // このスクリプト自身のパネルなら真。
  function isPanel(el) {
    return !el || el.id === PANEL_ID || (el.closest && el.closest("#" + PANEL_ID));
  }

  // 画面内に見えている要素なら真。
  function shown(el) {
    if (!el || !el.isConnected || isPanel(el)) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 40 && rect.height > 40;
  }

  // 開いている生成情報のポップアップを返す。
  function infoDialog() {
    return Array.from(document.querySelectorAll("[role='dialog'], .van-popup")).find((el) => {
      if (!shown(el)) return false;
      const text = String(el.innerText || "");
      return text.indexOf("プロンプト") >= 0 && text.indexOf("作成日時") >= 0 && text.indexOf("シード") >= 0;
    }) || null;
  }

  // 生成情報の文章を項目ごとに分ける。
  function parseInfo(raw) {
    const lines = String(raw || "").split(/\n/).map((line) => line.trim()).filter((line) => line && line !== "展開" && line !== "翻訳");
    const map = {};
    for (let i = 0; i < lines.length; i += 1) {
      if (LABELS.indexOf(lines[i]) < 0) continue;
      const multiline = lines[i] === "プロンプト" || lines[i] === "ネガティブプロンプト";
      let end = i + 2;
      if (multiline) {
        end = lines.length;
        for (let j = i + 1; j < lines.length; j += 1) {
          if (LABELS.indexOf(lines[j]) >= 0) {
            end = j;
            break;
          }
        }
      }
      const value = lines.slice(i + 1, end).join("\n").trim();
      if (LABELS.indexOf(value) < 0) map[lines[i]] = value;
      i = end - 1;
    }
    const last = LABELS.filter((label) => map[label]).pop();
    let rest = [];
    if (last) {
      const at = lines.lastIndexOf(last);
      rest = lines.slice(at + 2).filter((line) => line !== "現在のパラメータを保存" && line !== "創作");
    }
    const version = rest.find((line) => /^v\d/i.test(line)) || "";
    const modelType = rest.find((line) => /Checkpoint|LoRA|Lora/i.test(line)) || "";
    const model = rest.find((line) => line !== version && line !== modelType) || "";
    return {
      prompt: map["プロンプト"] || "",
      negative_prompt: map["ネガティブプロンプト"] || "",
      type: map["創作タイプ"] || "",
      created_at: map["作成日時"] || "",
      size: map["画像サイズ"] || "",
      seed: map["シード"] || "",
      sampler: map["サンプラー"] || "",
      scheduler: map["スケジューラー"] || "",
      steps: map["ステップ"] || "",
      cfg_scale: map["CFGスケール"] || "",
      clip_skip: map["Clip Skip"] || "",
      model_type: modelType,
      model: model,
      model_version: version
    };
  }

  // 画面中央に見えている作品画像を返す。
  function viewerImage() {
    const imgs = Array.from(document.querySelectorAll("img.task-image-viewer__img")).filter((img) => {
      if (!img.isConnected || isPanel(img)) return false;
      const rect = img.getBoundingClientRect();
      return rect.width > 80 && rect.height > 80 && rect.left < window.innerWidth / 2 && rect.right > window.innerWidth / 2;
    });
    imgs.sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width);
    return imgs[0] || null;
  }

  // imgのURLを取り、低解像度ならhighに直す。
  function imageUrl(img) {
    const raw = String(img.currentSrc || img.getAttribute("data-src") || img.src || "").split("?")[0];
    if (!raw || raw.indexOf("data:") === 0) return "";
    if (/_low\.webp$/i.test(raw)) return raw.replace(/_low\.webp$/i, "_high.webp");
    return raw;
  }

  // そのURLへGETする。プロンプトは付けない。Cookieヘッダも自分では付けない。
  function fetchBytes(url) {
    const request = typeof GM_xmlhttpRequest === "function"
      ? GM_xmlhttpRequest
      : (typeof GM !== "undefined" ? GM.xmlHttpRequest : null);
    if (!request) return Promise.reject(new Error("ダウンロード機能がありません"));
    return new Promise((resolve, reject) => {
      request({
        method: "GET",
        url: url,
        responseType: "arraybuffer",
        timeout: 60000,
        onload: (response) => {
          if (response.status >= 200 && response.status < 300 && response.response) {
            resolve(new Uint8Array(response.response));
            return;
          }
          reject(new Error("HTTP " + response.status));
        },
        onerror: () => reject(new Error("network")),
        ontimeout: () => reject(new Error("timeout"))
      });
    });
  }

  // PNGの検査用の数値を計算する。
  function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i += 1) c = CRC[(c ^ data[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // 数値を4バイトの並びにする。
  function u32be(value) {
    return new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);
  }

  // バイト列を順に繋ぐ。
  function concat(parts) {
    let size = 0;
    parts.forEach((part) => { size += part.length; });
    const out = new Uint8Array(size);
    let offset = 0;
    parts.forEach((part) => {
      out.set(part, offset);
      offset += part.length;
    });
    return out;
  }

  // PNGの1区画を作る。
  function pngChunk(type, data) {
    const name = new TextEncoder().encode(type);
    const body = concat([name, data]);
    return concat([u32be(data.length), body, u32be(crc32(body))]);
  }

  // UTF-8の生成情報をPNGのiTXtにする。
  function iTXt(keyword, text) {
    const enc = new TextEncoder();
    return pngChunk("iTXt", concat([
      enc.encode(keyword),
      new Uint8Array([0, 0, 0, 0, 0]),
      enc.encode(text)
    ]));
  }

  // 生成情報をPNGの末尾の直前に入れる。
  function insertMetadata(png, text) {
    const parts = [png.slice(0, 8)];
    let offset = 8;
    while (offset + 12 <= png.length) {
      const length = (png[offset] << 24) | (png[offset + 1] << 16) | (png[offset + 2] << 8) | png[offset + 3];
      const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
      const bytes = png.slice(offset, offset + 12 + length);
      if (type === "IEND") parts.push(iTXt("parameters", text));
      parts.push(bytes);
      offset += 12 + length;
      if (type === "IEND") break;
    }
    return concat(parts);
  }

  // 画面の画像サイズを、横x縦の表記にする。
  function a1111Size(size) {
    const match = String(size || "").match(/(\d+)\s*[x×]\s*(\d+)/i);
    return match ? match[1] + "x" + match[2] : "";
  }

  // 画面に年月日があればそれを使い、時刻だけなら画像URLの日付を使う。
  function chosenDate(info, url) {
    const shown = String(info.created_at || "").trim();
    const screen = shown.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
    if (screen) return { shown: shown, y: screen[1], m: screen[2], d: screen[3] };
    const fromUrl = String(url).match(/\/(\d{4})-(\d{2})-(\d{2})\//);
    if (!fromUrl) return { shown: shown, y: "", m: "", d: "" };
    const day = fromUrl[1] + "/" + fromUrl[2] + "/" + fromUrl[3];
    const withTime = /^\d{1,2}:\d{2}:\d{2}$/.test(shown) ? day + " " + shown : (shown || day);
    return { shown: withTime, y: fromUrl[1], m: fromUrl[2], d: fromUrl[3] };
  }

  // 選んだ日付を、メタデータ用の文字列にする。
  function createdStamp(info, url) {
    return chosenDate(info, url).shown;
  }

  // Automatic1111形式の生成情報の文章を作る。
  function metadataText(info, url) {
    const lines = [info.prompt];
    if (info.negative_prompt) lines.push("Negative prompt: " + info.negative_prompt);
    const parts = [];
    if (info.steps) parts.push("Steps: " + info.steps);
    if (info.sampler) parts.push("Sampler: " + info.sampler);
    if (info.scheduler) parts.push("Schedule type: " + info.scheduler);
    if (info.cfg_scale) parts.push("CFG scale: " + info.cfg_scale);
    if (info.seed) parts.push("Seed: " + info.seed);
    if (a1111Size(info.size)) parts.push("Size: " + a1111Size(info.size));
    const model = [info.model, info.model_version].filter(Boolean).join(" ");
    if (model) parts.push("Model: " + model);
    if (info.clip_skip) parts.push("Clip skip: " + info.clip_skip);
    const created = createdStamp(info, url);
    if (created) parts.push("Created: " + created);
    if (parts.length) lines.push(parts.join(", "));
    return lines.join("\n");
  }

  // 保存するPNGのファイル名を作る。
  function fileName(info, url) {
    const date = chosenDate(info, url);
    const stamp = date.y ? date.y + date.m.padStart(2, "0") + date.d.padStart(2, "0") : "seaart";
    const hash = (String(url).split("/").pop() || "image").replace(/_high\.webp$/i, "").replace(/[^A-Za-z0-9]/g, "");
    return stamp + "-" + hash + ".png";
  }

  // 受け取ったwebpを同じ大きさのPNGにする。通信はしない。
  async function webpToPng(bytes) {
    const blob = new Blob([bytes], { type: "image/webp" });
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error("webpを読めません"));
        img.src = url;
      });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d").drawImage(img, 0, 0);
      const png = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!png) throw new Error("pngにできません");
      return new Uint8Array(await png.arrayBuffer());
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // 開いている1枚と生成情報からPNGを作る。
  async function captureOne() {
    const dialog = infoDialog();
    if (!dialog) throw new Error("先にℹ️を開いてください");
    const img = viewerImage();
    if (!img) throw new Error("作品画像が見つかりません");
    const url = imageUrl(img);
    if (!url) throw new Error("画像URLがありません");
    const info = parseInfo(dialog.innerText);
    if (!info.created_at || String(info.prompt || "").length < 8) throw new Error("生成情報を読めません");
    showStatus("画像を取得");
    const webp = await fetchBytes(url);
    showStatus("PNGに変換");
    const png = await webpToPng(webp);
    return {
      name: fileName(info, url),
      bytes: insertMetadata(png, metadataText(info, url)),
      seed: info.seed,
      size: info.size
    };
  }

  // パネルを開閉する。
  function setExpanded(next) {
    expanded = next;
    if (!bodyNode || !launcher) return;
    bodyNode.style.display = next ? "block" : "none";
    launcher.textContent = next ? "×" : "PNG";
  }

  // 右下の操作パネルを置く。
  function ensurePanel() {
    if (!onCreatePage()) {
      if (panel) panel.remove();
      panel = null;
      return;
    }
    if (panel && document.body.contains(panel)) return;

    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText = "position:fixed;z-index:2147483647;right:8px;bottom:72px;width:max-content;max-width:calc(100vw - 16px)";
    panel.addEventListener("touchstart", (event) => event.stopPropagation(), true);
    panel.addEventListener("pointerdown", (event) => event.stopPropagation(), true);

    launcher = document.createElement("button");
    launcher.type = "button";
    launcher.textContent = "PNG";
    launcher.style.cssText = "min-width:44px;height:32px;padding:0 8px;border:0;border-radius:999px;background:#243044;color:#fff;font:12px -apple-system,sans-serif;box-shadow:0 4px 12px rgba(0,0,0,.25)";
    launcher.addEventListener("click", () => {
      const next = !expanded;
      setExpanded(next);
      if (next) showStatus(initialStatus());
    });
    panel.appendChild(launcher);

    bodyNode = document.createElement("div");
    bodyNode.style.cssText = "display:none;margin-bottom:6px;width:188px;padding:8px;border-radius:12px;background:rgba(255,253,248,.96);color:#1c1914;border:1px solid #e4ddd0;font:12px/1.3 -apple-system,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.18)";
    statusNode = document.createElement("div");
    statusNode.textContent = initialStatus();
    statusNode.style.cssText = "color:#6b6458;margin-bottom:6px;white-space:pre-wrap";
    bodyNode.appendChild(statusNode);

    const row = document.createElement("div");
    // 角丸のボタンを作る。
    function pill(label, background) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.style.cssText = "padding:6px 8px;border:0;border-radius:999px;background:" + background + ";color:#fff;font:12px -apple-system,sans-serif";
      return button;
    }
    const action = pill("PNG生成&保存", "#243044");
    action.style.display = "block";
    action.style.width = "100%";
    action.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      action.disabled = true;
      try {
        const made = await captureOne();
        const file = new File([made.bytes], made.name, { type: "image/png" });
        if (!navigator.share || !navigator.canShare || !navigator.canShare({ files: [file] })) {
          showStatus("このブラウザでは共有できません");
          return;
        }
        showStatus("生成情報入りPNG完成");
        // 端末の共有シート。PNGをどこかへ送信する処理ではない。
        await navigator.share({ files: [file], title: made.name });
        showStatus("生成情報入りPNG保存完了");
      } catch (error) {
        if (error && error.name === "AbortError") {
          showStatus("キャンセル");
          return;
        }
        showStatus("失敗: " + (error && error.message ? error.message : error));
        setExpanded(true);
      } finally {
        busy = false;
        action.disabled = false;
      }
    });
    row.appendChild(action);
    bodyNode.appendChild(row);
    panel.insertBefore(bodyNode, launcher);
    document.body.appendChild(panel);
    setExpanded(false);
  }

  ensurePanel();
  window.addEventListener("popstate", ensurePanel);
  setInterval(ensurePanel, 1500);
})();
