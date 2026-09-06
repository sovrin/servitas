export function usePolling(refresh: () => Promise<unknown>) {
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight = false
  onMounted(() => {
    timer = setInterval(async () => {
      if (inFlight || document.hidden) return
      inFlight = true
      try {
        await refresh()
      } finally {
        inFlight = false
      }
    }, 2000)
  })
  onUnmounted(() => clearInterval(timer))
}
