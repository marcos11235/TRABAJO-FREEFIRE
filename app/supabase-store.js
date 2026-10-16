const { createClient } = require("@supabase/supabase-js");

let client;

function getSupabase() {
  if (client) return client;
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("Configura SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY en el entorno del servidor.");
  }
  client = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  return client;
}

async function execute(query) {
  const { data, error } = await query;
  if (error) {
    const failure = new Error(error.message);
    failure.code = error.code;
    failure.details = error.details;
    throw failure;
  }
  return data;
}

module.exports = { execute, getSupabase };
