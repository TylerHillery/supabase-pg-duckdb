import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { SQL, S3Client, write } from "bun";

class S3 {
  client: S3Client;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  internalEndpoint: string;

  constructor(opts: {
    externalEndpoint: string;
    internalEndpoint: string;
    accessKeyId: string;
    secretAccessKey: string;
    region: string;
  }) {
    this.client = new S3Client({
      endpoint: opts.externalEndpoint,
      accessKeyId: opts.accessKeyId,
      secretAccessKey: opts.secretAccessKey,
      region: opts.region,
    });
    this.accessKeyId = opts.accessKeyId;
    this.secretAccessKey = opts.secretAccessKey;
    this.region = opts.region;
    this.internalEndpoint = opts.internalEndpoint;
  }

  async upload(bucket: string, objectPath: string, localFile: string) {
    await write(this.client.file(`${bucket}/${objectPath}`), Bun.file(localFile));
  }
}

class DB {
  pg: SQL;

  constructor(url: string) {
    this.pg = new SQL(url);
  }

  async insertOrder(
    userId: string,
    productName: string,
    quantity: number,
    unitPrice: number,
    status: string,
  ): Promise<number> {
    const [row] = await this.pg`
      INSERT INTO public.orders (user_id, product_name, quantity, unit_price, status)
      VALUES (${userId}, ${productName}, ${quantity}, ${unitPrice}, ${status})
      RETURNING id
    `;
    return row.id as number;
  }
}

async function main() {
    const SUPABASE_PUBLIC_URL = requireEnv("SUPABASE_PUBLIC_URL");
    const SUPABASE_ANON_KEY = requireEnv("ANON_KEY");
    const SUPABASE_SERVICE_ROLE_KEY = requireEnv("SERVICE_ROLE_KEY");
    const S3_KEY_ID = requireEnv("S3_PROTOCOL_ACCESS_KEY_ID");
    const S3_SECRET = requireEnv("S3_PROTOCOL_ACCESS_KEY_SECRET");
    const S3_REGION = requireEnv("REGION");
    const STORAGE_S3_ENDPOINT_INTERNAL = requireEnv("STORAGE_S3_ENDPOINT_INTERNAL");
    // S3 protocol endpoint for uploads from this script.
    // Uses a dedicated port that proxies directly to storage (bypassing Kong) so
    // AWS Sig V4 host headers are not rewritten by Kong's x-forwarded-port injection.
    const STORAGE_S3_PUBLIC_URL = process.env.STORAGE_S3_PUBLIC_URL ?? `http://localhost:8889/s3`;

    const POSTGRES_HOST = process.env.POSTGRES_HOST_DIRECT ?? "localhost";
    const POSTGRES_DB = requireEnv("POSTGRES_DB");
    const POSTGRES_PORT = process.env.POSTGRES_PORT_DIRECT ?? "5433";
    const POSTGRES_PASSWORD = requireEnv("POSTGRES_PASSWORD");
    const HTTP_PROXY = process.env.HTTP_PROXY;

    const DATABASE_URL = `postgresql://postgres:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`;
    // const DATABASE_URL = `postgresql://supabase_admin:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`;

    const db = new DB(DATABASE_URL);
    const s3 = new S3({
      externalEndpoint: STORAGE_S3_PUBLIC_URL,
      internalEndpoint: STORAGE_S3_ENDPOINT_INTERNAL,
      accessKeyId: S3_KEY_ID,
      secretAccessKey: S3_SECRET,
      region: S3_REGION,
    });
    const anonClient = createClient(SUPABASE_PUBLIC_URL, SUPABASE_ANON_KEY);
    const serviceClient = createClient(SUPABASE_PUBLIC_URL, SUPABASE_SERVICE_ROLE_KEY);

    console.log("Connected to Supabase at", SUPABASE_PUBLIC_URL);

    // Create test users
    console.log("Creating test users...");
    const aliceId = await signUpOrSignIn("alice@test.local", "password123", anonClient);
    console.log(`  Alice: ${aliceId}`);

    const bobId = await signUpOrSignIn("bob@test.local", "password123", anonClient);
    console.log(`  Bob:   ${bobId}`);

    const results = await Promise.allSettled([
      seedOrders(db, aliceId, bobId),
      seedTaxiTrips(db, s3, serviceClient, aliceId, bobId, HTTP_PROXY),
    ]);
    for (const result of results) {
      if (result.status === "rejected") console.error("Seed error:", result.reason);
    }
}

await main();

// Util functions
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function seedOrders(db: DB, aliceId: string, bobId: string) {
  await Promise.all([
    db.insertOrder(aliceId, "USB-C Hub",           2,   2999, "shipped"),
    db.insertOrder(aliceId, "Monitor Stand",       1,   4999, "processing"),
    db.insertOrder(aliceId, "Webcam 4K",           1,   8999, "pending"),
    db.insertOrder(aliceId, "Desk Mat XL",         1,   2499, "delivered"),
    db.insertOrder(aliceId, "Mechanical Keyboard", 1,  14999, "delivered"),
    db.insertOrder(bobId,   "Noise-Cancelling Headphones", 1, 19999, "delivered"),
    db.insertOrder(bobId,   "Laptop Stand",        1,   3999, "shipped"),
    db.insertOrder(bobId,   "Wireless Mouse",      2,   3499, "pending"),
  ]);
  console.log("  Seeded orders (5 Alice, 3 Bob)");
}

async function seedTaxiTrips(db: DB, s3: S3, serviceClient: SupabaseClient, aliceId: string, bobId: string, httpProxy?: string) {
  const BUCKET = "raw";
  const S3_OBJECT_PATH = "yellow-taxi-trips/2023/01/data.parquet";
  const LOCAL_FILE = "data/yellow_tripdata_2023-01.parquet";

  const { error: bucketErr } = await serviceClient.storage.createBucket(BUCKET, { public: false });
  if (bucketErr && !bucketErr.message.includes("already exists")) {
    throw new Error(`createBucket: ${bucketErr.message}`);
  }
  console.log(`  Bucket '${BUCKET}' ready`);

  await s3.upload(BUCKET, S3_OBJECT_PATH, LOCAL_FILE);
  console.log(`  Uploaded ${LOCAL_FILE} → s3://${BUCKET}/${S3_OBJECT_PATH}`);

  if (httpProxy) {
    await db.pg.unsafe(`SELECT duckdb.raw_query($$CREATE OR REPLACE SECRET http_proxy (TYPE http, HTTP_PROXY '${httpProxy}')$$)`);
    console.log(`  DuckDB HTTP proxy set to ${httpProxy}`);
  }

  // await db.pg.unsafe(`
  //   SELECT duckdb.create_simple_secret(
  //     type      := 'S3',
  //     key_id    := '${s3.accessKeyId}',
  //     secret    := '${s3.secretAccessKey}',
  //     region    := '${s3.region}',
  //     endpoint  := '${s3.internalEndpoint}',
  //     use_ssl   := 'false',
  //     url_style := 'path',
  //     scope     := 's3://${BUCKET}/'
  //   )
  // `);

  await db.pg.unsafe(`
    CREATE SERVER IF NOT EXISTS duckdb_supabase_storage_foreign_server
    TYPE 's3'
    FOREIGN DATA WRAPPER duckdb
    OPTIONS (
      endpoint  '${s3.internalEndpoint}',
      region    '${s3.region}',
      url_style 'path',
      use_ssl   'false',
      scope     's3://${BUCKET}/'
    )
  `);

  const roles = ["supabase_admin", "postgres", "service_role"];
  for (const role of roles) {
    await db.pg.unsafe(`
      CREATE USER MAPPING IF NOT EXISTS FOR ${role} SERVER duckdb_supabase_storage_foreign_server
      OPTIONS (KEY_ID '${s3.accessKeyId}', SECRET '${s3.secretAccessKey}')
    `);
  }

  await db.pg.unsafe(`
    CREATE TABLE IF NOT EXISTS public.yellow_taxi_trips AS
    SELECT
        *,
        CASE WHEN r['VendorID'] = 1
          THEN '${aliceId}'::UUID
          ELSE '${bobId}'::UUID
        END AS user_id
    FROM
        extensions.read_parquet('s3://${BUCKET}/${S3_OBJECT_PATH}') r
  `);

  await db.pg`ALTER TABLE public.yellow_taxi_trips ENABLE ROW LEVEL SECURITY`;
  await db.pg`ALTER TABLE public.yellow_taxi_trips FORCE ROW LEVEL SECURITY`;
  await db.pg`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename  = 'yellow_taxi_trips'
          AND policyname = 'Users can view own trips'
      ) THEN
        CREATE POLICY "Users can view own trips"
          ON public.yellow_taxi_trips FOR SELECT
          USING (user_id = (SELECT auth.uid()));
      END IF;
    END $$
  `;
  await db.pg`GRANT SELECT ON public.yellow_taxi_trips TO authenticated`;
  console.log("  Created public.yellow_taxi_trips from parquet");
}

async function signUpOrSignIn(
  email: string,
  password: string,
  anonClient: SupabaseClient,
): Promise<string> {
  const { data, error } = await anonClient.auth.signUp({ email, password });
  if (!error && data.user) return data.user.id;

  if (error?.message?.includes("already registered")) {
    const { data: signIn, error: signInErr } =
      await anonClient.auth.signInWithPassword({ email, password });
    if (signInErr) throw new Error(`signIn(${email}): ${signInErr.message}`);
    return signIn.user.id;
  }

  throw new Error(`signUp(${email}): ${error?.message}`);
}