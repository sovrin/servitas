export function formatTime(value: number | null) {
  if (!value) return '—'
  return (
    new Intl.DateTimeFormat('en-GB', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(value) + ' UTC'
  )
}

export function errorMessage(error: unknown) {
  const response = error as { data?: { statusMessage?: string } }
  return response?.data?.statusMessage || 'Could not reach the platform. Please try again.'
}
