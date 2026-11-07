import { DomainError } from './errors';

export interface MoneyProps {
  amount: string;
  currency: string;
}

const currencies = new Set(Intl.supportedValuesOf('currency'));
const MAX_MINOR = 99_999_999_999_999_999_999n; // NUMERIC(20,2)

export class Money {
  private constructor(
    private readonly minor: bigint,
    public readonly currency: string,
  ) {
    if (!currencies.has(currency) || minor > MAX_MINOR || minor < -MAX_MINOR) {
      throw new DomainError('INVALID_INPUT', 'Unsupported currency or monetary overflow');
    }
    Object.freeze(this);
  }

  static from({ amount, currency }: MoneyProps): Money {
    if (typeof amount !== 'string' || !/^(0|[1-9]\d{0,17})\.\d{2}$/.test(amount)) {
      throw new DomainError(
        'INVALID_INPUT',
        'Money requires a non-negative decimal string with 2 places',
      );
    }
    return new Money(BigInt(amount.replace('.', '')), currency);
  }

  /** Database values may be signed; public input contracts may not. */
  static rehydrate({ amount, currency }: MoneyProps): Money {
    const negative = amount.startsWith('-');
    const parsed = Money.from({ amount: negative ? amount.slice(1) : amount, currency });
    return negative ? parsed.negate() : parsed;
  }

  static zero(currency: string): Money {
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minor + other.minor, this.currency);
  }

  subtract(other: Money): Money {
    return this.add(other.negate());
  }

  negate(): Money {
    return new Money(-this.minor, this.currency);
  }

  isZero(): boolean {
    return this.minor === 0n;
  }

  isPositive(): boolean {
    return this.minor > 0n;
  }

  isNegative(): boolean {
    return this.minor < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor < other.minor;
  }

  equals(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minor === other.minor;
  }

  toString(): string {
    const magnitude = this.minor < 0n ? -this.minor : this.minor;
    return `${this.minor < 0n ? '-' : ''}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new DomainError('CURRENCY_MISMATCH', 'Cannot combine different currencies');
    }
  }
}
