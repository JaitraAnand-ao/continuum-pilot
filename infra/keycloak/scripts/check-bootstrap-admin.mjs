/* Post-deploy check (AD-6): the temporary bootstrap admin must be gone. Keycloak marks the
 * user or service client it creates from KC_BOOTSTRAP_ADMIN_* with the attribute
 * is_temporary_admin=true; while one remains in the master realm, this exits 1 and the
 * deployment fails.
 *
 *   SR_KEYCLOAK_ADMIN_URL    internal admin URL (never routed by the edge)
 *   SR_KEYCLOAK_ADMIN_TOKEN  bearer token of the permanent operator account
 *
 * Run it with scripts/check-bootstrap-admin.sh.
 */

const query = new URLSearchParams({ q: 'is_temporary_admin:true' })

/**
 * @param {{ baseUrl: string, token: string, fetch: (url: string, init?: RequestInit) => Promise<Response> }} options
 * @returns {Promise<string[]>} one entry per temporary admin still present
 */
export async function findTemporaryAdmins({ baseUrl, token, fetch }) {
  const admin = `${baseUrl.replace(/\/+$/, '')}/admin/realms/master`
  /** @param {string} path */
  const get = async (path) => {
    const response = await fetch(`${admin}${path}`, { headers: { authorization: `Bearer ${token}` } })
    if (!response.ok) throw new Error(`GET ${path} answered ${response.status}`)
    return response.json()
  }
  /** @type {{ username: string }[]} */
  const users = await get(`/users?${query}&briefRepresentation=true`)
  /** @type {{ clientId: string }[]} */
  const clients = await get(`/clients?${query}`)
  return [...users.map((user) => `user ${user.username}`), ...clients.map((client) => `client ${client.clientId}`)]
}

/**
 * @param {{ env: Record<string, string | undefined>, fetch: (url: string, init?: RequestInit) => Promise<Response>, log: (line: string) => void }} io
 * @returns {Promise<number>} the process exit code
 */
export async function main({ env, fetch, log }) {
  const baseUrl = env.SR_KEYCLOAK_ADMIN_URL
  const token = env.SR_KEYCLOAK_ADMIN_TOKEN
  if (!baseUrl || !token) {
    log('set SR_KEYCLOAK_ADMIN_URL and SR_KEYCLOAK_ADMIN_TOKEN')
    return 2
  }
  try {
    const remaining = await findTemporaryAdmins({ baseUrl, token, fetch })
    if (remaining.length === 0) {
      log('no temporary bootstrap admin remains in the master realm')
      return 0
    }
    log(`temporary bootstrap admin still present: ${remaining.join(', ')}; delete it before this deployment can pass`)
    return 1
  } catch (problem) {
    log(`cannot verify the bootstrap admin is gone: ${problem}`)
    return 1
  }
}
