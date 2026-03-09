import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { SQL } from "bun";

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

    const POSTGRES_HOST = "localhost";
    const POSTGRES_DB = requireEnv("POSTGRES_DB");
    const POSTGRES_PORT = "5433";
    const POSTGRES_PASSWORD = requireEnv("POSTGRES_PASSWORD");

    const DATABASE_URL = `postgresql://postgres:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`;

    const db = new DB(DATABASE_URL);
    const anonClient = createClient(SUPABASE_PUBLIC_URL, SUPABASE_ANON_KEY);
    const serviceClient = createClient(SUPABASE_PUBLIC_URL, SUPABASE_SERVICE_ROLE_KEY);

    console.log("Connected to Supabase at", SUPABASE_PUBLIC_URL);

    // Create test users
    console.log("Creating test users...");
    const aliceId = await signUpOrSignIn("alice@test.local", "password123", anonClient);
    console.log(`  Alice: ${aliceId}`);

    const bobId = await signUpOrSignIn("bob@test.local", "password123", anonClient);
    console.log(`  Bob:   ${bobId}`);

    await Promise.all([
      seedOrders(db, aliceId, bobId),
      // seedTaxiTrips(db),
    ]);
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