async function request(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    throw new Error('unauthenticated');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${body}`);
  }
  return res.json();
}

export const api = {
  me: () => request('/api/me'),
  clients: () => request('/api/clients'),
  events: (params) => request('/api/events?' + new URLSearchParams(params).toString()),
  event: (id) => request(`/api/events/${id}`),
  summary: (params) => request('/api/stats/summary?' + new URLSearchParams(params).toString()),
  suppression: (params) =>
    request('/api/suppression?' + new URLSearchParams(params).toString()),

  // admin
  adminClients: () => request('/api/admin/clients'),
  adminCreateClient: (data) =>
    request('/api/admin/clients', { method: 'POST', body: JSON.stringify(data) }),
  adminDeleteClient: (id) => request(`/api/admin/clients/${id}`, { method: 'DELETE' }),
  adminCreateMailServer: (clientId, data) =>
    request(`/api/admin/clients/${clientId}/mail-servers`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  adminDeleteMailServer: (id) =>
    request(`/api/admin/mail-servers/${id}`, { method: 'DELETE' }),
  adminRotateMailServer: (id) =>
    request(`/api/admin/mail-servers/${id}/rotate`, { method: 'POST' }),
  adminMailServerInfo: (id) => request(`/api/admin/mail-servers/${id}/info`),
  adminUsers: () => request('/api/admin/users'),
  adminUpsertUser: (data) =>
    request('/api/admin/users', { method: 'POST', body: JSON.stringify(data) }),
  adminUpsertMembership: (data) =>
    request('/api/admin/memberships', { method: 'POST', body: JSON.stringify(data) }),
  adminDeleteMembership: (userId, clientId) =>
    request(`/api/admin/memberships/${userId}/${clientId}`, { method: 'DELETE' }),

  logout: () => fetch('/auth/logout', { method: 'POST', credentials: 'include' }),
};
