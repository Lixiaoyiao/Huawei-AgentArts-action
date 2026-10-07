/** Return an element by a nonnegative integer index; throw RangeError outside the array. */
export function at(values, index) {
  if (!Number.isInteger(index) || index < 0 || index > values.length) {
    throw new RangeError("Index out of bounds");
  }
  return values[index];
}
