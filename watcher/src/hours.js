function toMinutes(hhmm) {
  const [hours, minutes] = hhmm.split(":").map(Number);
  return hours * 60 + minutes;
}

export function localClock(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type) => parts.find((p) => p.type === type).value;
  return {
    weekday: part("weekday"),
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

export function isBusinessHours(now, businessHours) {
  const clock = localClock(now, businessHours.timeZone);
  return (
    businessHours.days.includes(clock.weekday) &&
    clock.minutes >= toMinutes(businessHours.start) &&
    clock.minutes < toMinutes(businessHours.end)
  );
}

export function businessDate(now, businessHours) {
  return localClock(now, businessHours.timeZone).date;
}
