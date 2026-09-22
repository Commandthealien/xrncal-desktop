import React from 'react'

/**
 * Shown when the app cannot start at all - no database, or no native bridge.
 *
 * Deliberately plain: it must render without i18n, without the theme hook and
 * without anything that reads from the database, because any of those may be
 * the thing that failed.
 */
const BootFailure: React.FC<{ reason: string; detail: string }> = ({ reason, detail }) => (
  <div
    style={{
      display: 'flex',
      minHeight: '100vh',
      flexDirection: 'column',
      justifyContent: 'center',
      gap: 12,
      padding: '32px 24px',
      background: '#2b2d31',
      color: '#dbdee1',
      fontFamily: 'Inter, system-ui, sans-serif'
    }}
  >
    <h1 style={{ fontSize: 17, fontWeight: 600, margin: 0 }}>xrncal could not start</h1>
    <p style={{ fontSize: 14, margin: 0, color: '#9aa0a6' }}>{reason}</p>
    <pre
      style={{
        fontSize: 11,
        margin: 0,
        padding: 12,
        borderRadius: 4,
        background: '#232428',
        color: '#9aa0a6',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word'
      }}
    >
      {detail}
    </pre>
  </div>
)

export default BootFailure
