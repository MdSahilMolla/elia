import json, math

def discounted(value, rate, year):
    return value / ((1 + rate) ** year)

def compute_npv(config):
    # config contains keys: saas_monthly, dev_cost, infra_year1, maint_pct, opp_pct, discount_rate, years
    r = config.get('discount_rate', 0.05)
    years = config.get('years', 3)
    # SaaS cashflows
    saas_annual = config['saas_monthly'] * 12
    saas_npv = sum(discounted(saas_annual, r, y) for y in range(1, years+1))
    # Build cashflows
    dev = config['dev_cost']
    infra = config.get('infra_year1', 0)
    maint_pct = config.get('maint_pct', 0.20)
    opp_pct = config.get('opp_pct', 0.10)
    # Year0 dev cost (no discount)
    build_npv = dev
    for y in range(1, years+1):
        maint = dev * maint_pct
        opp = dev * opp_pct
        build_npv += discounted(infra if y == 1 else 0, r, y)
        build_npv += discounted(maint, r, y)
        build_npv += discounted(opp, r, y)
    return saas_npv, build_npv

if __name__ == "__main__":
    import argparse, sys
    parser = argparse.ArgumentParser(description="Simple CRM cost NPV calculator")
    parser.add_argument('config', help='Path to JSON config file')
    args = parser.parse_args()
    try:
        with open(args.config) as f:
            cfg = json.load(f)
    except Exception as e:
        sys.exit(f"Failed to load config: {e}")
    saas_npv, build_npv = compute_npv(cfg)
    diff = saas_npv - build_npv
    print(f"Buy (SaaS) NPV: ${saas_npv:,.2f}")
    print(f"Build NPV: ${build_npv:,.2f}")
    print(f"Difference (Buy - Build): ${diff:,.2f}")
    if diff > 0:
        print("Buy is cheaper over the horizon.")
    else:
        print("Build is cheaper over the horizon.")
