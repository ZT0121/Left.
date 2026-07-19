const CACHE_VERSION = "left-20260719.17";

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key !== CACHE_VERSION)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  event.respondWith((async () => {
    try {
      const response = await fetch(request, { cache: "no-store" });
      return response;
    } catch (error) {
      const cached = await caches.match(request);
      if (cached) return cached;
      throw error;
    }
  })());
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch (error) {
    payload = { title: "Left.", body: event.data?.text() || "你有一筆待處理提醒。" };
  }

  event.waitUntil(self.registration.showNotification(payload.title || "Left.", {
    body: payload.body || "你有一筆待處理提醒。",
    icon: payload.icon || "./assets/branding/left-icon-192.png",
    badge: payload.badge || "./assets/branding/left-favicon-64.png",
    tag: payload.tag || "left-reminder",
    renotify: true,
    data: { url: payload.url || "./index.html" }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "./index.html", self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => new URL(client.url).origin === new URL(targetUrl).origin);
    if (existing) {
      await existing.focus();
      if ("navigate" in existing) await existing.navigate(targetUrl);
      return;
    }
    await self.clients.openWindow(targetUrl);
  })());
});
