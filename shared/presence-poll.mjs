export function presencePoll({ read, publish, schedule = setInterval, cancel = clearInterval }) {
  let active = false, stopped = false, pending = false, generation = 0, timer;
  async function refresh() {
    if (!active || stopped || pending) return;
    pending = true;
    const current = generation;
    try {
      const value = await read();
      if (active && !stopped && current === generation) publish(value);
    } finally {
      pending = false;
      if (active && !stopped && current !== generation) void refresh();
    }
  }
  return {
    setActive(value) {
      if (stopped || value === active) return;
      active = value; ++generation; cancel(timer);
      if (active) { void refresh(); timer = schedule(() => void refresh(), 10000); }
    },
    stop() { stopped = true; active = false; ++generation; cancel(timer); },
  };
}
