from roman import to_roman
for n, want in [(4,"IV"),(9,"IX"),(14,"XIV"),(40,"XL"),(90,"XC"),(400,"CD"),(900,"CM"),(1994,"MCMXCIV"),(2024,"MMXXIV")]:
    got = to_roman(n)
    assert got == want, f"{n}: got {got}, want {want}"
print("ok")
