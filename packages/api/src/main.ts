/* The deployable's entry point. */
import { loadConfig } from './config.js'
import { createServer } from './server.js'

const config = loadConfig(process.env)
await createServer(config).listen({ host: '0.0.0.0', port: config.port })
