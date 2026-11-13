export class CalculationError extends Error {}

export const calculationError = (message: string): never => { throw new CalculationError(message); };
