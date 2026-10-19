/* The snapshot's shape, as the Graph ports (IF-13, IF-14) hand it over: already mapped out of
 * Graph's wire format by the adapter, so nothing here knows a Graph property name. */

export const SIGN_IN_TYPES = ['interactiveUser', 'nonInteractiveUser', 'servicePrincipal', 'managedIdentity'] as const

export type SignInType = (typeof SIGN_IN_TYPES)[number]

export interface ConditionalAccessResult {
  policyId: string
  displayName: string
  result: string
}

export interface DeviceDetail {
  deviceId?: string
  operatingSystem?: string
  browser?: string
  isCompliant?: boolean
  isManaged?: boolean
  trustType?: string
}

export interface SignIn {
  id: string
  /* ISO 8601 instant in UTC, millisecond precision. */
  createdAt: string
  type: SignInType
  /* 0 is a successful sign-in; any other Entra error code is a failure. */
  errorCode: number
  conditionalAccessPolicies: ConditionalAccessResult[]
  device: DeviceDetail
}

export interface RiskDetection {
  id: string
  detectedAt: string
  riskEventType: string
  riskLevel: string
}

/* The names a report gives a source it could not collect (AC-5). */
export const SOURCE_NAMES = {
  interactiveUser: 'Interactive user sign-ins',
  nonInteractiveUser: 'Non-interactive user sign-ins',
  servicePrincipal: 'Service principal sign-ins',
  managedIdentity: 'Managed identity sign-ins',
  identityProtection: 'Identity Protection risk data',
} as const satisfies Record<SignInType | 'identityProtection', string>

export type SourceName = (typeof SOURCE_NAMES)[keyof typeof SOURCE_NAMES]
