"""Generates test CSVs with planted data quality problems, plus answer keys.

Run:  python3 samples/generate_samples.py
Output:
  samples/messy_customers.csv   + samples/messy_customers.answer.json
  samples/clean_customers.csv   + samples/clean_customers.answer.json

Every planted problem goes on its own row, so the expected counts are exact.
Change the numbers in PLANT to create harder or easier test sets for your evals.
"""

import csv
import json
import random
from datetime import date, timedelta
from pathlib import Path

OUT = Path(__file__).parent
FIRST = ["Olivia", "Jack", "Mia", "Noah", "Isla", "Leo", "Ava", "Oliver", "Zara", "Liam", "Priya", "Arjun",
         "Chloe", "Ethan", "Grace", "Lucas", "Sophie", "Harry", "Mei", "Kai", "Ruby", "Sam", "Ella", "Tom"]
LAST = ["Smith", "Nguyen", "Brown", "Patel", "Wilson", "Taylor", "Singh", "Chen", "Kelly", "Martin",
        "Walker", "Khan", "Wright", "Lee", "Harris", "Clark", "Young", "King", "Scott", "Green"]
STATES = {"VIC": "3", "NSW": "2", "QLD": "4", "SA": "5", "WA": "6"}
COLUMNS = ["customer_id", "first_name", "last_name", "email", "phone", "state", "postcode",
           "signup_date", "lifetime_value", "status"]

PLANT = {
    "missing_email": 10,
    "invalid_email": 8,
    "invalid_phone": 6,
    "inconsistent_state": 9,
    "invalid_postcode": 4,
    "invalid_date": 5,
    "outlier_value": 3,
    "inconsistent_status": 5,
    "missing_last_name": 3,
    "near_duplicates": 4,
    "exact_duplicates": 6,
}


def clean_row(i: int, rng: random.Random) -> dict:
    first, last = rng.choice(FIRST), rng.choice(LAST)
    state = rng.choice(list(STATES))
    mobile = "04" + "".join(str(rng.randint(0, 9)) for _ in range(8))
    return {
        "customer_id": f"C{10000 + i}",
        "first_name": first,
        "last_name": last,
        "email": f"{first.lower()}.{last.lower()}{i}@example.com",
        "phone": f"{mobile[:4]} {mobile[4:7]} {mobile[7:]}",
        "state": state,
        "postcode": STATES[state] + f"{rng.randint(0, 999):03d}",
        "signup_date": (date(2022, 1, 1) + timedelta(days=rng.randint(0, 1400))).isoformat(),
        "lifetime_value": f"{rng.uniform(50, 5000):.2f}",
        "status": rng.choice(["Active", "Active", "Active", "Inactive"]),
    }


def write(name: str, rows: list[dict], answer: dict) -> None:
    with open(OUT / f"{name}.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COLUMNS)
        w.writeheader()
        w.writerows(rows)
    (OUT / f"{name}.answer.json").write_text(json.dumps(answer, indent=2) + "\n")
    print(f"wrote {name}.csv ({len(rows)} rows)")


def messy() -> None:
    rng = random.Random(703)
    rows = [clean_row(i, rng) for i in range(200)]
    free = list(range(200))
    rng.shuffle(free)

    def take(n: int) -> list[int]:
        return [free.pop() for _ in range(n)]

    for i in take(PLANT["missing_email"]):
        rows[i]["email"] = ""
    bad_emails = ["jack.smith@example", "mia nguyen@example.com", "noah@@example.com", "isla.example.com",
                  "leo@", "ava@example.c", "@example.com", "oliver@exa mple.com"]
    for i, bad in zip(take(PLANT["invalid_email"]), bad_emails):
        rows[i]["email"] = bad
    for i, bad in zip(take(PLANT["invalid_phone"]), ["12345", "0412 345", "99 9999 9999", "phone", "0412-345-67890", "1800 FLOWERS"]):
        rows[i]["phone"] = bad
    variants = ["Victoria"] * 4 + ["vic"] * 2 + ["New South Wales"] * 3
    for i, v in zip(take(PLANT["inconsistent_state"]), variants):
        rows[i]["state"] = v
    for i, bad in zip(take(PLANT["invalid_postcode"]), ["30OO", "300", "30001", "VIC3000"]):
        rows[i]["postcode"] = bad
    for i, bad in zip(take(PLANT["invalid_date"]), ["31/02/2025", "2025-13-01", "yesterday", "2024-02-30", "15-07-2025"]):
        rows[i]["signup_date"] = bad
    for i, v in zip(take(PLANT["outlier_value"]), ["999999.00", "250000.00", "180000.00"]):
        rows[i]["lifetime_value"] = v
    for i, v in zip(take(PLANT["inconsistent_status"]), ["active", "ACTIVE", "active ", "inactive", "INACTIVE"]):
        rows[i]["status"] = v
    for i in take(PLANT["missing_last_name"]):
        rows[i]["last_name"] = ""

    # Near duplicates: same person re-entered with a new ID and different casing/spacing.
    near = []
    for n, i in enumerate(take(PLANT["near_duplicates"])):
        d = dict(rows[i])
        d["customer_id"] = f"C{20000 + n}"
        d["email"] = d["email"].upper()
        d["first_name"] = d["first_name"] + " "
        near.append(d)
    # Exact duplicates: whole row copied (e.g. an import run twice).
    exact = [dict(rows[i]) for i in take(PLANT["exact_duplicates"])]

    all_rows = rows + near + exact
    answer = {
        "description": "Planted issues. 'count' is the number of affected rows the agent should report.",
        "expected_issues": [
            {"column": "email", "issue_type": "missing_values", "count": PLANT["missing_email"]},
            {"column": "email", "issue_type": "invalid_format", "count": PLANT["invalid_email"]},
            {"column": "phone", "issue_type": "invalid_format", "count": PLANT["invalid_phone"]},
            {"column": "state", "issue_type": "inconsistent_values", "count": PLANT["inconsistent_state"]},
            {"column": "postcode", "issue_type": "invalid_format", "count": PLANT["invalid_postcode"]},
            {"column": "signup_date", "issue_type": "invalid_format", "count": PLANT["invalid_date"]},
            {"column": "lifetime_value", "issue_type": "outliers", "count": PLANT["outlier_value"]},
            {"column": "status", "issue_type": "inconsistent_values", "count": PLANT["inconsistent_status"]},
            {"column": "last_name", "issue_type": "missing_values", "count": PLANT["missing_last_name"]},
            {"column": "*", "issue_type": "duplicates", "count": PLANT["exact_duplicates"] + PLANT["near_duplicates"],
             "note": "6 exact copies + 4 near-duplicates (same email, different case and ID)"},
        ],
    }
    write("messy_customers", all_rows, answer)


def clean() -> None:
    rng = random.Random(42)
    rows = [clean_row(i, rng) for i in range(60)]
    write("clean_customers", rows, {
        "description": "No planted issues. Any high or medium issue reported is a false positive.",
        "expected_issues": [],
    })


if __name__ == "__main__":
    messy()
    clean()
