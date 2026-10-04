// Exact rational arithmetic so 7/2*2 is exactly 7, never a float approximation.
const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) [a, b] = [b, a % b]; return a; };

export class Fraction {
  constructor(num, den = 1) {
    if (den === 0) throw new Error('Division by zero');
    if (den < 0) { num = -num; den = -den; }
    const g = gcd(num, den) || 1;
    this.num = num / g;
    this.den = den / g;
  }
  add(o) { return new Fraction(this.num * o.den + o.num * this.den, this.den * o.den); }
  sub(o) { return new Fraction(this.num * o.den - o.num * this.den, this.den * o.den); }
  mul(o) { return new Fraction(this.num * o.num, this.den * o.den); }
  div(o) {
    if (o.num === 0) throw new Error('Division by zero');
    return new Fraction(this.num * o.den, this.den * o.num);
  }
  isInteger() { return this.den === 1; }
  equals(o) { return this.num === o.num && this.den === o.den; }
  key() { return `${this.num}/${this.den}`; }
  toString() { return this.den === 1 ? String(this.num) : `${this.num}/${this.den}`; }
}
