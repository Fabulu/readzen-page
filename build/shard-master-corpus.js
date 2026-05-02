import { readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";

const SRC = "C:/Programmieren/CbetaZenTranslations/master-corpus.json";
const OUT_DIR = "C:/Programmieren/CbetaZenTranslations/corpus/masters";

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/['ʼ']/g, "")
    .replace(/ /g, "_");
}

async function main() {
  console.log("Reading master-corpus.json …");
  const raw = await readFile(SRC, "utf8");
  const corpus = JSON.parse(raw);

  const names = Object.keys(corpus.masters);
  console.log(`Found ${names.length} masters in corpus (version ${corpus.version}).`);

  await mkdir(OUT_DIR, { recursive: true });

  // Write individual master shards
  const indexMasters = {};
  for (const name of names) {
    const data = corpus.masters[name];
    const slug = slugify(name);

    await writeFile(
      join(OUT_DIR, `${slug}.json`),
      JSON.stringify(data),
      "utf8"
    );

    indexMasters[name] = {
      slug,
      p: data.primary_count,
      s: data.secondary_count,
      m: data.total_mentions,
    };
  }

  // Write _index.json
  const index = {
    version: 2,
    corpus: corpus.corpus,
    file_count: corpus.file_count,
    master_count: names.length,
    built_utc: new Date().toISOString(),
    masters: indexMasters,
  };

  await writeFile(
    join(OUT_DIR, "_index.json"),
    JSON.stringify(index, null, 2),
    "utf8"
  );

  console.log(`Sharded ${names.length} masters to ${OUT_DIR}`);
  console.log(`Wrote _index.json (version 2)`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
