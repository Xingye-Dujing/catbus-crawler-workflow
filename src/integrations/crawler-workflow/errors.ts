import type { ErrorCode } from '../../core/errors.js'

const EXIT_ERROR_CODES: Record<number, ErrorCode> = {
  1: 'ERROR',
  2: 'USAGE',
  3: 'AUTH_REQUIRED',
  4: 'NOT_IMPLEMENTED',
  5: 'RISK_CONTROL',
  6: 'NETWORK',
  7: 'UPSTREAM',
}

/** CatBus 进程没给出 JSON 信封时，用退出码判断错误类别（AGENTS 6.4）。 */
export function errorCodeForExit(code: number): ErrorCode {
  return EXIT_ERROR_CODES[code] ?? 'ERROR'
}
