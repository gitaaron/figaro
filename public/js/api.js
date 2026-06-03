// api.js — thin wrapper around the backend JSON API.

async function req(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

export const api = {
  getProviders: () => req('GET', '/api/providers'),

  listCourses: () => req('GET', '/api/courses'),
  getCourse: (id) => req('GET', `/api/courses/${id}`),
  deleteCourse: (id) => req('DELETE', `/api/courses/${id}`),

  assess: (topic, provider) => req('POST', '/api/assess', { topic, provider }),

  createCourse: (topic, provider, answers) =>
    req('POST', '/api/courses', { topic, provider, answers }),

  generateLesson: (courseId, index, provider, regenerate = false) =>
    req('POST', `/api/courses/${courseId}/lessons/${index}/generate`, { provider, regenerate }),

  completeLesson: (courseId, index, score) =>
    req('POST', `/api/courses/${courseId}/lessons/${index}/complete`, { score }),
};
