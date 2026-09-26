/*
 * Myind bridge shim, contract v1 (packages/bridge/CONTRACT.md §2). Native injects this file at document start, only
 * into the main frame of a `myind-bundle://` page, after replacing the two placeholders (CONNECT_TOKEN and
 * CHANNEL_KEY below; each appears exactly once) with fresh random lowercase hex, 32+ characters, for every page load:
 *   connect token  also written into the bundle's <meta name="myind-bridge" content="token=...;version=1;min=1">
 *   channel key    never given to the page; native passes it as the first argument of every
 *                  window.myind.__resolve / __emit call
 * iOS: a WKUserScript (.atDocumentStart, forMainFrameOnly). Android: WebViewCompat.addDocumentStartJavaScript with
 * the bundle origin, plus WebViewCompat.addWebMessageListener(webView, "myindNative", setOf(origin), listener).
 *
 * What it guarantees: page code can't replace window.myind, can't reroute requests by patching the handler or
 * Reflect / JSON after load, can't connect without the token or connect twice, and can't forge resolves or events
 * without the channel key. It uses no prototype methods after load, so poisoning Array/Function/Object prototypes
 * doesn't reach it. What it doesn't: page code can still post anything straight to the native handler, and code
 * that runs before the bundle's client can read the token from the meta tag. Native is the trust boundary.
 */
(function () {
  'use strict';
  var VERSION = 1; // highest bridge version this app build speaks
  var MIN_VERSION = 1; // lowest bridge version this app build still speaks
  var MAX_QUEUED_EVENTS = 64;
  var CONNECT_TOKEN = '__MYIND_CONNECT_TOKEN__';
  var CHANNEL_KEY = '__MYIND_CHANNEL_KEY__';
  // Captured before any page script runs.
  var apply = Reflect.apply;
  var stringify = JSON.stringify;
  var defineProperty = Object.defineProperty;
  var create = Object.create;
  var hex = /^[0-9a-f]{32,128}$/;

  if (Object.prototype.hasOwnProperty.call(window, 'myind')) return;
  if (!hex.test(CONNECT_TOKEN) || !hex.test(CHANNEL_KEY) || CONNECT_TOKEN === CHANNEL_KEY) {
    if (window.console && console.error) console.error('myind bridge: shim injected without per-page secrets');
    return;
  }

  var handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.myind;
  var android = window.myindNative;
  var platform;
  var post;
  if (handler && typeof handler.postMessage === 'function') {
    var webkitPost = handler.postMessage;
    platform = 'ios';
    post = function (request) {
      apply(webkitPost, handler, [request]);
    };
  } else if (android && typeof android.postMessage === 'function') {
    var androidPost = android.postMessage;
    platform = 'android';
    post = function (request) {
      apply(androidPost, android, [stringify(request)]);
    };
  } else {
    return; // Not inside the app: the website uses the web adapter instead.
  }

  var receiver = null;
  var connected = false;
  // Events emitted before the bundle's client connects, in a prototype-less object: no Array.prototype method or
  // inherited index setter is ever involved.
  var queued = create(null);
  var queuedCount = 0;

  function report(where) {
    try {
      if (window.console && console.error) console.error('myind bridge: ' + where + ' failed');
    } catch (ignored) {}
  }

  function enqueue(event, payload) {
    var next = create(null);
    var n = 0;
    // Keep order, keep only the newest playback frame, drop the oldest past the cap.
    var start = queuedCount >= MAX_QUEUED_EVENTS ? 1 : 0;
    for (var i = start; i < queuedCount; i++) {
      if (event === 'playback' && queued[i][0] === 'playback') continue;
      next[n] = queued[i];
      n++;
    }
    next[n] = [event, payload];
    queued = next;
    queuedCount = n + 1;
  }

  var api = {
    version: VERSION,
    minVersion: MIN_VERSION,
    platform: platform,
    __resolve: function (key, id, result, error) {
      if (key !== CHANNEL_KEY || typeof id !== 'string' || !receiver) return;
      try {
        receiver.resolve(id, result, error === undefined ? null : error);
      } catch (err) {
        report('resolve');
      }
    },
    __emit: function (key, event, payload) {
      if (key !== CHANNEL_KEY || typeof event !== 'string') return;
      if (!receiver) {
        enqueue(event, payload);
        return;
      }
      try {
        receiver.emit(event, payload);
      } catch (err) {
        report('emit');
      }
    },
    __connect: function (token, next) {
      if (connected) throw new Error('myind bridge already connected');
      if (token !== CONNECT_TOKEN) throw new Error('myind bridge connect token rejected');
      if (!next || typeof next.resolve !== 'function' || typeof next.emit !== 'function') {
        throw new TypeError('myind bridge receiver needs resolve() and emit()');
      }
      connected = true;
      receiver = next;
      var backlog = queued;
      var count = queuedCount;
      queued = create(null);
      queuedCount = 0;
      // The client holds these until it starts (after the bundle subscribes); see createBridgeClient.
      for (var i = 0; i < count; i++) {
        try {
          receiver.emit(backlog[i][0], backlog[i][1]);
        } catch (err) {
          report('emit');
        }
      }
      return function (request) {
        post(request);
      };
    },
  };

  defineProperty(window, 'myind', {
    value: Object.freeze(api),
    writable: false,
    configurable: false,
    enumerable: false,
  });
})();
