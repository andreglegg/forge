def to_roman(n):
    values = [(1000, "M"), (500, "D"), (100, "C"), (50, "L"), (10, "X"), (5, "V"), (1, "I")]
    out = ""
    for value, symbol in values:
        while n >= value:
            out += symbol
            n -= value
    return out
