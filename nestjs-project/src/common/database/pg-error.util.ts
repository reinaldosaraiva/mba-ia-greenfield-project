import { QueryFailedError } from 'typeorm';

export const PG_UNIQUE_VIOLATION = '23505';

interface PostgresDriverError extends Error {
  code?: string;
  detail?: string;
}

export function isUniqueViolationOnColumn(
  error: unknown,
  column: string,
): boolean {
  if (!(error instanceof QueryFailedError)) return false;

  const { code, detail } = error.driverError as PostgresDriverError;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(column)
  );
}
