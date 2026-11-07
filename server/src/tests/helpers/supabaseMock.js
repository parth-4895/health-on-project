/**
 * A stand-in for supabase-js query chains.
 *
 * Every builder method (select, eq, in, …) returns the same chain, and the
 * chain resolves to the configured result however it is finished: awaited
 * directly, or via single() / maybeSingle(). Tests describe tables rather
 * than re-typing the exact call sequence a controller happens to use.
 */

const BUILDER_METHODS = [
  'select', 'insert', 'upsert', 'update', 'delete',
  'eq', 'neq', 'in', 'is', 'not', 'or', 'order', 'limit', 'match',
  'like', 'ilike',
  'gte', 'lte', 'gt', 'lt',
];

function ok(data) {
  return { data, error: null };
}

function fail(message) {
  return { data: null, error: { message } };
}

function queryChain(result) {
  const chain = {};
  for (const method of BUILDER_METHODS) chain[method] = jest.fn(() => chain);
  chain.single = jest.fn(() => Promise.resolve(result));
  chain.maybeSingle = jest.fn(() => Promise.resolve(result));
  chain.then = (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected);
  return chain;
}

/**
 * Routes `supabaseAdmin.from(table)` to canned results.
 *
 * Each table maps to a result, or to an array of results served in call
 * order (the last one repeats) for tables a request reads more than once.
 * Returns the chains handed out per table so a test can assert on them.
 */
function mockTables(supabaseAdmin, tables) {
  const chains = {};

  supabaseAdmin.from.mockImplementation((table) => {
    if (!(table in tables)) throw new Error(`Test did not expect a query on "${table}"`);

    const spec = tables[table];
    const issued = (chains[table] = chains[table] || []);
    const result = Array.isArray(spec) ? spec[Math.min(issued.length, spec.length - 1)] : spec;

    const chain = queryChain(result);
    issued.push(chain);
    return chain;
  });

  return chains;
}

/** The profile row authGuard reads; clinicians are verified unless a test says otherwise. */
function profileRow(role, { verified = true, fullName = 'Test User' } = {}) {
  return ok({
    role,
    full_name: fullName,
    clinician_details: role === 'clinician' ? { is_verified: verified } : null,
  });
}

module.exports = { ok, fail, queryChain, mockTables, profileRow };
