import type { Player, Role, Team } from "../../data/types";

// All organisations and players below are fictional placeholders.
// Replace with your real ISEC participants (or load them from your API).

export const teams: Team[] = [
  { slug: "northwind", name: "Northwind", tag: "NW", country: "Denmark", countryCode: "DK", founded: 2019, coach: "Halvard" },
  { slug: "vanta", name: "Vanta Esports", tag: "VNT", country: "France", countryCode: "FR", founded: 2017, coach: "Mercier" },
  { slug: "kairos", name: "Kairos", tag: "KRS", country: "Brazil", countryCode: "BR", founded: 2020, coach: "Tavares" },
  { slug: "monolith", name: "Monolith", tag: "MNL", country: "Ukraine", countryCode: "UA", founded: 2016, coach: "Kovalenko" },
  { slug: "static-five", name: "Static Five", tag: "ST5", country: "United States", countryCode: "US", founded: 2021, coach: "Reyes" },
  { slug: "obsidian", name: "Obsidian", tag: "OBS", country: "Sweden", countryCode: "SE", founded: 2018, coach: "Lindqvist" },
  { slug: "halcyon", name: "Halcyon", tag: "HCN", country: "Poland", countryCode: "PL", founded: 2019, coach: "Wójcik" },
  { slug: "iron-lotus", name: "Iron Lotus", tag: "ILT", country: "China", countryCode: "CN", founded: 2020, coach: "Zhou" },
  { slug: "parallax", name: "Parallax", tag: "PLX", country: "Germany", countryCode: "DE", founded: 2018, coach: "Brandt" },
  { slug: "zenith", name: "Zenith Collective", tag: "ZEN", country: "Finland", countryCode: "FI", founded: 2022, coach: "Virtanen" },
  { slug: "nocturne", name: "Nocturne", tag: "NOC", country: "Spain", countryCode: "ES", founded: 2021, coach: "Ortega" },
  { slug: "arc-seven", name: "Arc Seven", tag: "AR7", country: "Australia", countryCode: "AU", founded: 2019, coach: "Whitlock" },
  { slug: "granite", name: "Granite", tag: "GRN", country: "Czechia", countryCode: "CZ", founded: 2020, coach: "Novák" },
  { slug: "helix", name: "Helix", tag: "HLX", country: "Mongolia", countryCode: "MN", founded: 2021, coach: "Batbayar" },
  { slug: "quietus", name: "Quietus", tag: "QTS", country: "Turkey", countryCode: "TR", founded: 2022, coach: "Aydın" },
  { slug: "lumen", name: "Lumen", tag: "LMN", country: "Portugal", countryCode: "PT", founded: 2023, coach: "Ferreira" },
];

type Seed = [nickname: string, first: string, last: string, role: Role, age: number];

const rosters: Record<string, Seed[]> = {
  northwind: [
    ["frost", "Mads", "Holm", "IGL", 27], ["skarp", "Emil", "Lund", "AWP", 22], ["bolt", "Jonas", "Berg", "Entry", 21],
    ["tide", "Oliver", "Krog", "Support", 25], ["vael", "Lukas", "Dahl", "Lurker", 23],
  ],
  vanta: [
    ["nox", "Hugo", "Lefèvre", "IGL", 28], ["sable", "Théo", "Garnier", "AWP", 24], ["kyx", "Nolan", "Roux", "Entry", 20],
    ["mistral", "Louis", "Faure", "Support", 26], ["eclat", "Arthur", "Blanc", "Rifler", 22],
  ],
  kairos: [
    ["trovão", "Lucas", "Moreira", "IGL", 29], ["fino", "Gabriel", "Costa", "AWP", 23], ["zap", "Rafael", "Lima", "Entry", 21],
    ["brisa", "Pedro", "Alves", "Support", 25], ["sombra", "Mateus", "Rocha", "Lurker", 24],
  ],
  monolith: [
    ["granit", "Oleh", "Bondar", "IGL", 30], ["prism", "Artem", "Shevchenko", "AWP", 21], ["vortex", "Denys", "Melnyk", "Entry", 22],
    ["kvant", "Ihor", "Tkachenko", "Support", 26], ["shade", "Maksym", "Kravets", "Rifler", 19],
  ],
  "static-five": [
    ["relay", "Ethan", "Brooks", "IGL", 26], ["longshot", "Mason", "Price", "AWP", 23], ["rush", "Logan", "Hayes", "Entry", 20],
    ["anchor", "Caleb", "Ward", "Support", 27], ["ghost", "Owen", "Reed", "Lurker", 24],
  ],
  obsidian: [
    ["kall", "Erik", "Nyström", "IGL", 28], ["glint", "Viktor", "Ek", "AWP", 22], ["storm", "Axel", "Sjöberg", "Entry", 21],
    ["mosa", "Linus", "Hall", "Support", 25], ["fjell", "Anton", "Wiberg", "Rifler", 23],
  ],
  halcyon: [
    ["kruk", "Piotr", "Mazur", "IGL", 27], ["iskra", "Kacper", "Lis", "AWP", 21], ["grom", "Jakub", "Nowak", "Entry", 22],
    ["cisza", "Michał", "Wrona", "Support", 26], ["lotny", "Bartek", "Sowa", "Lurker", 24],
  ],
  "iron-lotus": [
    ["yun", "Wei", "Chen", "IGL", 26], ["jian", "Hao", "Lin", "AWP", 21], ["feng", "Jun", "Zhang", "Entry", 20],
    ["shan", "Lei", "Wang", "Support", 25], ["ying", "Bo", "Liu", "Rifler", 22],
  ],
  parallax: [
    ["kompass", "Felix", "Wagner", "IGL", 29], ["laser", "Paul", "Schmid", "AWP", 23], ["blitz", "Leon", "Becker", "Entry", 21],
    ["mauer", "Jonas", "Hoffmann", "Support", 27], ["nebel", "Tim", "Krüger", "Lurker", 24],
  ],
  zenith: [
    ["revontuli", "Aleksi", "Mäkinen", "IGL", 25], ["tähti", "Eetu", "Laine", "AWP", 20], ["salama", "Onni", "Heikkinen", "Entry", 19],
    ["kivi", "Joel", "Koskinen", "Support", 24], ["usva", "Niko", "Järvinen", "Rifler", 22],
  ],
  nocturne: [
    ["luna", "Álvaro", "Navarro", "IGL", 28], ["certero", "Pablo", "Ruiz", "AWP", 22], ["rayo", "Diego", "Molina", "Entry", 21],
    ["muro", "Sergio", "Iglesias", "Support", 26], ["sigilo", "Marcos", "Vidal", "Lurker", 23],
  ],
  "arc-seven": [
    ["dingo", "Liam", "Foster", "IGL", 27], ["reef", "Noah", "Carter", "AWP", 22], ["swell", "Jack", "Murray", "Entry", 21],
    ["mallee", "Cooper", "Hughes", "Support", 25], ["outback", "Riley", "Shaw", "Rifler", 24],
  ],
  granite: [
    ["skala", "Tomáš", "Dvořák", "IGL", 28], ["jiskra", "Jakub", "Černý", "AWP", 21], ["hrom", "Matěj", "Procházka", "Entry", 22],
    ["kotva", "Ondřej", "Kučera", "Support", 26], ["stín", "Filip", "Veselý", "Lurker", 23],
  ],
  helix: [
    ["tengri", "Temuulen", "Ganbold", "IGL", 25], ["bürged", "Enkh", "Bat-Erdene", "AWP", 21], ["salkhi", "Munkh", "Dorj", "Entry", 20],
    ["khad", "Tsogt", "Sukh", "Support", 24], ["chono", "Erdene", "Altan", "Rifler", 22],
  ],
  quietus: [
    ["sessiz", "Emre", "Yılmaz", "IGL", 27], ["kartal", "Burak", "Kaya", "AWP", 22], ["yıldırım", "Mert", "Demir", "Entry", 20],
    ["kale", "Can", "Şahin", "Support", 25], ["gölge", "Kerem", "Öztürk", "Lurker", 23],
  ],
  lumen: [
    ["farol", "João", "Silva", "IGL", 26], ["mira", "Tiago", "Santos", "AWP", 20], ["faísca", "Rui", "Oliveira", "Entry", 19],
    ["muralha", "André", "Pereira", "Support", 24], ["neblina", "Diogo", "Costa", "Rifler", 21],
  ],
};

const slugify = (s: string) =>
  s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-");

export const players: Player[] = teams.flatMap((team) =>
  (rosters[team.slug] ?? []).map(([nickname, firstName, lastName, role, age]) => ({
    slug: slugify(nickname),
    nickname,
    firstName,
    lastName,
    team: team.slug,
    role,
    countryCode: team.countryCode,
    age,
  })),
);
