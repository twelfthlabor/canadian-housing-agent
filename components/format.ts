export const money = (value: number) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(value);
export const compactMoney = (value: number) => value >= 1_000_000 || Math.round(value / 1000) >= 1000 ? `$${(value / 1_000_000).toFixed(2)}m` : `$${Math.round(value / 1000)}k`;
export const cityName = (value: string) => (({ "st-catharines": "St. Catharines", "sault-ste-marie": "Sault Ste. Marie", "chatham-kent": "Chatham-Kent" } as Record<string, string>)[value] ?? value.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" "));

export const PROVINCES: { code: string; name: string }[] = [
  { code: "AB", name: "Alberta" },
  { code: "BC", name: "British Columbia" },
  { code: "MB", name: "Manitoba" },
  { code: "NB", name: "New Brunswick" },
  { code: "NL", name: "Newfoundland and Labrador" },
  { code: "NS", name: "Nova Scotia" },
  { code: "NT", name: "Northwest Territories" },
  { code: "ON", name: "Ontario" },
  { code: "PE", name: "Prince Edward Island" },
  { code: "QC", name: "Quebec" },
  { code: "SK", name: "Saskatchewan" },
];
