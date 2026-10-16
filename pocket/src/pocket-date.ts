const sqlDateTime = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)$/
const naiveIsoDateTime = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)$/

export const normalizePocketTimestamp = (value: string): string => {
  const sql = sqlDateTime.exec(value)
  if (sql) return `${sql[1]}T${sql[2]}Z`
  const iso = naiveIsoDateTime.exec(value)
  return iso ? `${iso[1]}T${iso[2]}Z` : value
}
