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
  adminUpdateClient: (id, data) =>
    request(`/api/admin/clients/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
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
  adminDeleteUser: (userId) =>
    request(`/api/admin/users/${userId}`, { method: 'DELETE' }),
  adminResetPassword: (userId, password) =>
    request(`/api/admin/users/${userId}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  adminAuditLog: (params) =>
    request('/api/admin/audit-log?' + new URLSearchParams(params).toString()),
  adminUpsertMembership: (data) =>
    request('/api/admin/memberships', { method: 'POST', body: JSON.stringify(data) }),
  adminDeleteMembership: (userId, clientId) =>
    request(`/api/admin/memberships/${userId}/${clientId}`, { method: 'DELETE' }),

  changePassword: (currentPassword, newPassword) =>
    request('/api/me/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  logout: () => fetch('/auth/logout', { method: 'POST', credentials: 'include' }),
};
