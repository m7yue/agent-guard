import type { AgentGuardApi } from '../shared/contracts'

declare global {
  interface Window {
    agentguard: AgentGuardApi
  }
}

export {}
