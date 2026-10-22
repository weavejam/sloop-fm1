// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin page (/plugin/) is SLOOP's web editor (web/editor.html) on a SLOOP of its own: this classic script runs
// before the editor's and sets window.sloopHost (editor.html HOST), a Web MIDI access with one port pair, "SLOOP (this
// page)", in place of navigator.requestMIDIAccess: what the editor sends goes to the page's SLOOP (tutti.js sets
// `backend` once it runs; before that it waits here), what that SLOOP sends comes in through receive(). The editor
// tells attach() how to connect (tutti.js connects it once its SLOOP is on).
(function () {
  "use strict";
  var NAME = "SLOOP (this page)";
  var listeners = [];
  var input = {
    id: "sloop-page-in", name: NAME, manufacturer: "weavejam", type: "input", state: "connected", connection: "open",
    onmidimessage: null, onstatechange: null,
    open: function () { return Promise.resolve(input); },
    close: function () { return Promise.resolve(input); },
    addEventListener: function (t, f) { if (t === "midimessage" && listeners.indexOf(f) < 0) listeners.push(f); },
    removeEventListener: function (t, f) { var i = listeners.indexOf(f); if (i >= 0) listeners.splice(i, 1); },
  };
  var output = {
    id: "sloop-page-out", name: NAME, manufacturer: "weavejam", type: "output", state: "connected", connection: "open",
    onstatechange: null,
    open: function () { return Promise.resolve(output); },
    close: function () { return Promise.resolve(output); },
    send: function (data) { host.send(Uint8Array.from(data)); },
    clear: function () {},
  };
  var access = {
    inputs: new Map([[input.id, input]]), outputs: new Map([[output.id, output]]), sysexEnabled: true, onstatechange: null,
    addEventListener: function () {}, removeEventListener: function () {},
  };
  var host = window.sloopHost = {
    access: access,
    backend: null,                                     // (bytes) -> the page's SLOOP (tutti.js)
    waiting: [],
    editor: null,                                      // { connect, disconnect, connected, wanted } (editor.html)
    onEditor: null,
    send: function (d) {
      if (host.backend) host.backend(d);
      else if (host.waiting.length < 64) host.waiting.push(d);
    },
    // bytes from the page's SLOOP: each SysEx frame (F0 .. F7) and each channel message as one MIDI message
    receive: function (bytes) {
      var i = 0;
      while (i < bytes.length) {
        var j = i + 1;
        if (bytes[i] === 0xF0) { while (j < bytes.length && bytes[j - 1] !== 0xF7) j++; }
        else if (bytes[i] >= 0x80) { var st = bytes[i] & 0xF0; j = i + (st === 0xC0 || st === 0xD0 ? 2 : 3); }
        var ev = { data: bytes.slice(i, Math.min(j, bytes.length)), timeStamp: performance.now(), target: input };
        if (input.onmidimessage) input.onmidimessage(ev);
        for (var k = 0; k < listeners.length; k++) listeners[k](ev);
        i = j;
      }
    },
    attach: function (editor) {
      host.editor = editor;
      if (host.onEditor) host.onEditor(editor);
    },
  };
})();
