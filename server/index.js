require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { GoogleAdsApi } = require("google-ads-api");
const fetch = globalThis.fetch || require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../public")));

// ─── Google Ads Client ────────────────────────────────────────────────────────
const client = new GoogleAdsApi({
  client_id: process.env.GOOGLE_ADS_CLIENT_ID,
  client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
  developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
});

// Division → account ID map (supports comma-separated multiple IDs)
const DIVISIONS = {
  MX:  process.env.ACCOUNT_ID_MX,
  HE:  process.env.ACCOUNT_ID_HE,
  EBD: process.env.ACCOUNT_ID_EBD,
  DA:  process.env.ACCOUNT_ID_DA,
  EPP: process.env.ACCOUNT_ID_EPP,
};

// Numeric enum → string (google-ads-api v17+ returns integers)
const CHANNEL_TYPE_MAP = {
  0:"UNSPECIFIED",1:"UNKNOWN",2:"SEARCH",3:"DISPLAY",4:"SHOPPING",
  5:"HOTEL",6:"VIDEO",7:"MULTI_CHANNEL",8:"LOCAL",9:"SMART",
  10:"PERFORMANCE_MAX",11:"LOCAL_SERVICES",12:"DISCOVERY",13:"TRAVEL",
};
const CHANNEL_SUBTYPE_MAP = {
  0:"UNSPECIFIED",1:"UNKNOWN",2:"SEARCH_MOBILE_APP",3:"DISPLAY_MOBILE_APP",
  4:"SEARCH_EXPRESS",5:"DISPLAY_EXPRESS",6:"APP_CAMPAIGN",
  7:"APP_CAMPAIGN_FOR_ENGAGEMENT",8:"DISPLAY_SMART_CAMPAIGN",
  9:"SHOPPING_GOAL_OPTIMIZED_ADS",10:"DISPLAY_GMAIL_AD",11:"SMART_CAMPAIGN",
  12:"VIDEO_OUTSTREAM",13:"VIDEO_ACTION",14:"VIDEO_NON_SKIPPABLE",
  15:"APP_CAMPAIGN_FOR_PRE_REGISTRATION",16:"LOCAL_CAMPAIGN",
  17:"SHOPPING_COMPARISON_LISTING_ADS",18:"SMART_CAMPAIGN_ADS",
  19:"VIDEO_SEQUENCE",23:"TRAVEL_ACTIVITIES",
};

function resolveEnum(value, map) {
  if (typeof value === "number") return map[value] || String(value);
  return value || "UNSPECIFIED";
}

function detectCampaignType(rawChannelType, rawChannelSubType) {
  const channelType    = resolveEnum(rawChannelType,    CHANNEL_TYPE_MAP);
  const channelSubType = resolveEnum(rawChannelSubType, CHANNEL_SUBTYPE_MAP);
  switch (channelType) {
    case "SEARCH":          return { label: "Text",          googleType: "SEARCH" };
    case "SHOPPING":        return { label: "Shopping",      googleType: "SHOPPING" };
    case "PERFORMANCE_MAX": return { label: "Pmax",          googleType: "PERFORMANCE_MAX" };
    case "MULTI_CHANNEL":
      if (channelSubType === "APP_CAMPAIGN_FOR_ENGAGEMENT") return { label: "Shop App", googleType: "MULTI_CHANNEL / APP_CAMPAIGN_FOR_ENGAGEMENT" };
      if (channelSubType === "APP_CAMPAIGN")                return { label: "Shop App", googleType: "MULTI_CHANNEL / APP_CAMPAIGN" };
      return { label: "App", googleType: "MULTI_CHANNEL / " + channelSubType };
    case "DISPLAY":         return { label: "Display",       googleType: "DISPLAY" };
    case "VIDEO":           return { label: "Video",         googleType: "VIDEO" };
    case "SMART":           return { label: "Smart",         googleType: "SMART" };
    case "LOCAL":           return { label: "Local",         googleType: "LOCAL" };
    case "LOCAL_SERVICES":  return { label: "Local Services",googleType: "LOCAL_SERVICES" };
    case "HOTEL":           return { label: "Hotel",         googleType: "HOTEL" };
    case "DISCOVERY":       return { label: "Discovery",     googleType: "DISCOVERY" };
    case "TRAVEL":          return { label: "Travel",        googleType: "TRAVEL" };
    default:                return { label: channelType || "Other", googleType: channelType || "Other" };
  }
}

// ─── GAQL query builder ───────────────────────────────────────────────────────
function buildQuery(startDate, endDate) {
  return `
    SELECT
      campaign.name,
      campaign.advertising_channel_type,
      campaign.advertising_channel_sub_type,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.conversions,
      metrics.conversions_value,
      metrics.all_conversions_value,
      metrics.search_impression_share,
      metrics.search_top_impression_share
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status = 'ENABLED'
    ORDER BY metrics.cost_micros DESC
  `;
}

// ─── Query a single account ID ────────────────────────────────────────────────
async function queryAccount(accountId, startDate, endDate) {
  const customer = client.Customer({
    customer_id: accountId.replace(/-/g, ""),
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    login_customer_id: process.env.GOOGLE_ADS_MCC_ID?.replace(/-/g, ""),
  });
  return customer.query(buildQuery(startDate, endDate));
}

// ─── Fetch one division's data (handles multiple comma-separated IDs) ─────────
async function fetchAccount(divName, accountIdRaw, startDate, endDate) {
  if (!accountIdRaw) {
    console.warn(`No account ID configured for ${divName}`);
    return [];
  }

  // Split on comma to support multiple account IDs per division
  const accountIds = accountIdRaw.split(",").map(id => id.trim()).filter(Boolean);
  console.log(`Fetching ${divName} from ${accountIds.length} account(s): ${accountIds.join(", ")}`);

  // Fetch all accounts in parallel then flatten
  const allRows = (await Promise.all(
    accountIds.map(id => queryAccount(id, startDate, endDate))
  )).flat();

  // Aggregate by campaign type
  const byType = {};
  for (const row of allRows) {
    const detected = detectCampaignType(
      row.campaign.advertising_channel_type,
      row.campaign.advertising_channel_sub_type
    );
    const type = detected.label;
    const googleType = detected.googleType;
    if (!byType[type]) {
      byType[type] = {
        spend: 0, impressions: 0, clicks: 0,
        conversions: 0, revenue: 0,
        imp_share_sum: 0, top_imp_share_sum: 0,
        count: 0, is_count: 0,
        channel_type: googleType,
      };
    }
    const t = byType[type];
    t.count++;
    t.spend       += (row.metrics.cost_micros || 0) / 1_000_000;
    t.impressions += row.metrics.impressions || 0;
    t.clicks      += row.metrics.clicks || 0;
    t.conversions += row.metrics.conversions || 0;
    t.revenue     += row.metrics.conversions_value || 0;

    const rawIS  = parseFloat(row.metrics.search_impression_share || 0);
    const rawTIS = parseFloat(row.metrics.search_top_impression_share || 0);
    if (rawIS > 0 || rawTIS > 0) {
      t.imp_share_sum     += rawIS * 100;
      t.top_imp_share_sum += rawTIS * 100;
      t.is_count++;
    }
  }

  // Build per-type rows + a total row
  const results = [];
  const totals = { spend:0, impressions:0, clicks:0, conversions:0, revenue:0, imp_share_sum:0, top_imp_share_sum:0, count:0, is_count:0 };

  for (const [type, t] of Object.entries(byType)) {
    const ctr  = t.impressions > 0 ? (t.clicks / t.impressions) * 100 : 0;
    const cvr  = t.clicks > 0      ? (t.conversions / t.clicks) * 100 : 0;
    const roas = t.spend > 0       ? t.revenue / t.spend : 0;
    const is   = t.is_count > 0    ? t.imp_share_sum / t.is_count : 0;
    const tis  = t.is_count > 0    ? t.top_imp_share_sum / t.is_count : 0;

    results.push({
      div: divName, cam: type, channel_type: t.channel_type,
      spend: t.spend, impressions: t.impressions,
      clicks: t.clicks, ctr, conversions: t.conversions, revenue: t.revenue,
      roas, cvr, imp_share: is, top_imp_share: tis,
    });

    totals.spend        += t.spend;
    totals.impressions  += t.impressions;
    totals.clicks       += t.clicks;
    totals.conversions  += t.conversions;
    totals.revenue      += t.revenue;
    totals.imp_share_sum     += t.imp_share_sum;
    totals.top_imp_share_sum += t.top_imp_share_sum;
    totals.count             += t.count;
    totals.is_count          += t.is_count;
  }

  // Total row at the top
  results.unshift({
    div: divName,
    cam: divName === "EPP" ? "EPP" : "total",
    spend:       totals.spend,
    impressions: totals.impressions,
    clicks:      totals.clicks,
    ctr:         totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
    conversions: totals.conversions,
    revenue:     totals.revenue,
    roas:        totals.spend > 0 ? totals.revenue / totals.spend : 0,
    cvr:         totals.clicks > 0 ? (totals.conversions / totals.clicks) * 100 : 0,
    imp_share:     totals.is_count > 0 ? totals.imp_share_sum / totals.is_count : 0,
    top_imp_share: totals.is_count > 0 ? totals.top_imp_share_sum / totals.is_count : 0,
  });

  return results;
}

// ─── /api/report ──────────────────────────────────────────────────────────────
app.get("/api/report", async (req, res) => {
  try {
    const { startDate, endDate, prevStartDate, prevEndDate } = req.query;

    if (!startDate || !endDate || !prevStartDate || !prevEndDate) {
      return res.status(400).json({ error: "Missing date params. Required: startDate, endDate, prevStartDate, prevEndDate" });
    }

    for (const d of [startDate, endDate, prevStartDate, prevEndDate]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        return res.status(400).json({ error: `Invalid date format: ${d}. Use YYYY-MM-DD` });
      }
    }

    const divNames = Object.keys(DIVISIONS);

    const [curResults, prevResults] = await Promise.all([
      Promise.all(divNames.map(d => fetchAccount(d, DIVISIONS[d], startDate, endDate))),
      Promise.all(divNames.map(d => fetchAccount(d, DIVISIONS[d], prevStartDate, prevEndDate))),
    ]);

    const curFlat  = curResults.flat();
    const prevFlat = prevResults.flat();

    const merged = curFlat.map(cur => {
      const prev = prevFlat.find(p => p.div === cur.div && p.cam === cur.cam) || {};
      return { ...cur, prev };
    });

    res.json({
      periods: { current: { startDate, endDate }, previous: { startDate: prevStartDate, endDate: prevEndDate } },
      rows: merged,
      generatedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error("Google Ads API error:", err);
    res.status(500).json({
      error: err.message || "Failed to fetch Google Ads data",
      details: err.errors || null,
    });
  }
});


// ─── Campaign-level GAQL query ────────────────────────────────────────────────
function buildCampaignQuery(startDate, endDate) {
  return `
    SELECT
      campaign.id,
      campaign.name,
      campaign.advertising_channel_type,
      campaign.advertising_channel_sub_type,
      metrics.cost_micros,
      metrics.impressions,
      metrics.clicks,
      metrics.conversions,
      metrics.conversions_value,
      metrics.search_impression_share,
      metrics.search_top_impression_share,
      metrics.search_absolute_top_impression_share,
      metrics.search_budget_lost_impression_share,
      metrics.search_rank_lost_impression_share
    FROM campaign
    WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
      AND campaign.status = 'ENABLED'
    ORDER BY metrics.cost_micros DESC
  `;
}

// ─── /api/campaigns ───────────────────────────────────────────────────────────
app.get('/api/campaigns', async (req, res) => {
  try {
    const { startDate, endDate, prevStartDate, prevEndDate } = req.query;
    if (!startDate || !endDate || !prevStartDate || !prevEndDate) {
      return res.status(400).json({ error: 'Missing date params.' });
    }

    // Build all account tasks and run in parallel
    const camTasks = [];
    for (const [divName, accountIdRaw] of Object.entries(DIVISIONS)) {
      if (!accountIdRaw) continue;
      accountIdRaw.split(',').map(id => id.trim()).filter(Boolean).forEach(accountId => {
        camTasks.push({ divName, accountId });
      });
    }

    const camTaskResults = await Promise.all(camTasks.map(async ({ divName, accountId }) => {
      const customer = client.Customer({
        customer_id: accountId.replace(/-/g, ''),
        refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
        login_customer_id: process.env.GOOGLE_ADS_MCC_ID?.replace(/-/g, ''),
      });
      const [curRows, prevRows] = await Promise.all([
        customer.query(buildCampaignQuery(startDate, endDate)).catch(()=>[]),
        customer.query(buildCampaignQuery(prevStartDate, prevEndDate)).catch(()=>[]),
      ]);
      return { divName, curRows, prevRows };
    }));

    const results = [];
    for (const { divName, curRows, prevRows } of camTaskResults) {
        for (const row of curRows) {
          const detected = detectCampaignType(
            row.campaign.advertising_channel_type,
            row.campaign.advertising_channel_sub_type
          );
          const prevRow = prevRows.find(p => p.campaign.id === row.campaign.id);
          const toMetrics = (r) => {
            if (!r) return { spend:0, impressions:0, clicks:0, conversions:0, revenue:0, imp_share:0, top_is:0, abs_top_is:0, budget_lost_is:0, rank_lost_is:0 };
            return {
              spend:          (r.metrics.cost_micros || 0) / 1_000_000,
              impressions:     r.metrics.impressions || 0,
              clicks:          r.metrics.clicks || 0,
              conversions:     r.metrics.conversions || 0,
              revenue:         r.metrics.conversions_value || 0,
              imp_share:       parseFloat(r.metrics.search_impression_share || 0) * 100,
              top_is:          parseFloat(r.metrics.search_top_impression_share || 0) * 100,
              abs_top_is:      parseFloat(r.metrics.search_absolute_top_impression_share || 0) * 100,
              budget_lost_is:  parseFloat(r.metrics.search_budget_lost_impression_share || 0) * 100,
              rank_lost_is:    parseFloat(r.metrics.search_rank_lost_impression_share || 0) * 100,
            };
          };
          results.push({
            div:           divName,
            campaign_id:   row.campaign.id,
            campaign_name: row.campaign.name,
            campaign_type: detected.label,
            google_type:   detected.googleType,
            cur:           toMetrics(row),
            prev:          toMetrics(prevRow),
          });
        }
      }
    res.json({
      periods: { current: { startDate, endDate }, previous: { startDate: prevStartDate, endDate: prevEndDate } },
      campaigns: results,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Campaigns API error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch campaign data' });
  }
});

// ─── /api/accounts — verify all accounts are reachable ───────────────────────
app.get("/api/accounts", async (req, res) => {
  const results = {};
  for (const [div, accountIdRaw] of Object.entries(DIVISIONS)) {
    if (!accountIdRaw) { results[div] = { status: "missing" }; continue; }
    const accountIds = accountIdRaw.split(",").map(id => id.trim()).filter(Boolean);
    const accountResults = [];
    for (const accountId of accountIds) {
      try {
        const customer = client.Customer({
          customer_id: accountId.replace(/-/g, ""),
          refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
          login_customer_id: process.env.GOOGLE_ADS_MCC_ID?.replace(/-/g, ""),
        });
        const rows = await customer.query(`SELECT customer.descriptive_name, customer.id FROM customer LIMIT 1`);
        accountResults.push({ status: "ok", name: rows[0]?.customer?.descriptive_name, id: accountId });
      } catch (e) {
        accountResults.push({ status: "error", id: accountId, error: e.message });
      }
    }
    results[div] = accountResults.length === 1 ? accountResults[0] : { status: "ok", accounts: accountResults };
  }
  res.json(results);
});


// ─── Helper: get customer object ─────────────────────────────────────────────
function getCustomer(accountId) {
  return client.Customer({
    customer_id: accountId.replace(/-/g, ""),
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    login_customer_id: process.env.GOOGLE_ADS_MCC_ID?.replace(/-/g, ""),
  });
}

// ─── Safe query wrapper — never throws, returns [] on error ──────────────────
async function safeQuery(customer, gaql, label) {
  try { return await customer.query(gaql); }
  catch(e) { console.warn(`[${label}] skipped:`, e?.message || JSON.stringify(e)?.slice(0,200)); return []; }
}

// ─── Run all 7 queries for one account in parallel ───────────────────────────
async function fetchAccountInsights(accountId, divName, startDate, endDate) {
  const cust = getCustomer(accountId);
  const DEVICE_MAP = {0:"UNSPECIFIED",1:"UNKNOWN",2:"MOBILE",3:"TABLET",4:"DESKTOP",5:"CONNECTED_TV",6:"OTHER"};
  const DOW_MAP = {0:"UNSPECIFIED",1:"MONDAY",2:"TUESDAY",3:"WEDNESDAY",4:"THURSDAY",5:"FRIDAY",6:"SATURDAY",7:"SUNDAY"};
  const MATCH_MAP = {0:"UNSPECIFIED",1:"UNKNOWN",2:"EXACT",3:"PHRASE",4:"BROAD"};
  const AD_STRENGTH_MAP = {0:"UNSPECIFIED",1:"UNKNOWN",2:"PENDING",3:"NO_ADS",4:"POOR",5:"AVERAGE",6:"GOOD",7:"EXCELLENT"};

  // Fire all 7 queries simultaneously
  const [campRows, termRows, devRows, dowRows, kwRows, assetRows, audRows] = await Promise.all([
    safeQuery(cust, `SELECT campaign.name, campaign.advertising_channel_type, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value, metrics.search_impression_share, metrics.search_top_impression_share, metrics.search_budget_lost_impression_share, metrics.search_rank_lost_impression_share, metrics.ctr, metrics.average_cpc FROM campaign WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' AND campaign.status = 'ENABLED' AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 50`, `${divName}/campaigns`),
    safeQuery(cust, `SELECT search_term_view.search_term, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value, metrics.ctr FROM search_term_view WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' AND metrics.impressions > 10 ORDER BY metrics.cost_micros DESC LIMIT 100`, `${divName}/searchTerms`),
    safeQuery(cust, `SELECT segments.device, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' AND campaign.status = 'ENABLED' AND metrics.cost_micros > 0`, `${divName}/devices`),
    safeQuery(cust, `SELECT segments.day_of_week, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' AND campaign.status = 'ENABLED' AND metrics.cost_micros > 0`, `${divName}/dow`),
    safeQuery(cust, `SELECT ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, campaign.name, ad_group.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value, metrics.search_impression_share, metrics.average_cpc FROM keyword_view WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' AND ad_group_criterion.status = 'ENABLED' AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 100`, `${divName}/keywords`),
    safeQuery(cust, `SELECT asset_group.name, asset_group.ad_strength, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM asset_group WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' AND asset_group.status = 'ENABLED' AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 50`, `${divName}/assetGroups`),
    safeQuery(cust, `SELECT ad_group_criterion.user_list.user_list, ad_group_criterion.type, campaign.name, ad_group.name, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value, metrics.ctr FROM ad_group_audience_view WHERE segments.date BETWEEN '${startDate}' AND '${endDate}' AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT 50`, `${divName}/audiences`),
  ]);

  // Parse campaigns
  const campaigns = campRows.map(r => ({
    name: r.campaign.name,
    type: resolveEnum(r.campaign.advertising_channel_type, CHANNEL_TYPE_MAP),
    spend: (r.metrics.cost_micros||0)/1e6,
    impressions: r.metrics.impressions||0,
    clicks: r.metrics.clicks||0,
    conversions: r.metrics.conversions||0,
    revenue: r.metrics.conversions_value||0,
    roas: r.metrics.cost_micros > 0 ? (r.metrics.conversions_value||0)/((r.metrics.cost_micros||0)/1e6) : 0,
    ctr: (r.metrics.ctr||0)*100,
    avg_cpc: (r.metrics.average_cpc||0)/1e6,
    imp_share: parseFloat(r.metrics.search_impression_share||0)*100,
    top_is: parseFloat(r.metrics.search_top_impression_share||0)*100,
    budget_lost_is: parseFloat(r.metrics.search_budget_lost_impression_share||0)*100,
    rank_lost_is: parseFloat(r.metrics.search_rank_lost_impression_share||0)*100,
  }));

  // Parse search terms
  const searchTerms = termRows.map(r => ({
    term: r.search_term_view?.search_term||"unknown",
    campaign: r.campaign?.name||"",
    spend: (r.metrics.cost_micros||0)/1e6,
    impressions: r.metrics.impressions||0,
    clicks: r.metrics.clicks||0,
    conversions: r.metrics.conversions||0,
    revenue: r.metrics.conversions_value||0,
    ctr: (r.metrics.ctr||0)*100,
  }));

  // Parse devices (aggregate)
  const devMap = {};
  devRows.forEach(r => {
    const dev = resolveEnum(r.segments?.device, DEVICE_MAP);
    if (!devMap[dev]) devMap[dev] = {device:dev,spend:0,impressions:0,clicks:0,conversions:0,revenue:0};
    devMap[dev].spend += (r.metrics.cost_micros||0)/1e6;
    devMap[dev].impressions += r.metrics.impressions||0;
    devMap[dev].clicks += r.metrics.clicks||0;
    devMap[dev].conversions += r.metrics.conversions||0;
    devMap[dev].revenue += r.metrics.conversions_value||0;
  });
  const devices = Object.values(devMap).map(d => ({
    ...d,
    roas: d.spend>0?d.revenue/d.spend:0,
    ctr: d.impressions>0?(d.clicks/d.impressions)*100:0,
    cvr: d.clicks>0?(d.conversions/d.clicks)*100:0,
  }));

  // Parse day of week (aggregate)
  const dowMap = {};
  dowRows.forEach(r => {
    const dow = resolveEnum(r.segments?.day_of_week, DOW_MAP);
    if (!dowMap[dow]) dowMap[dow] = {day:dow,spend:0,impressions:0,clicks:0,conversions:0,revenue:0};
    dowMap[dow].spend += (r.metrics.cost_micros||0)/1e6;
    dowMap[dow].impressions += r.metrics.impressions||0;
    dowMap[dow].clicks += r.metrics.clicks||0;
    dowMap[dow].conversions += r.metrics.conversions||0;
    dowMap[dow].revenue += r.metrics.conversions_value||0;
  });
  const dayOfWeek = Object.values(dowMap).map(d => ({...d, roas:d.spend>0?d.revenue/d.spend:0}));

  // Parse keywords
  const keywords = kwRows.map(r => ({
    keyword: r.ad_group_criterion?.keyword?.text||"",
    match_type: resolveEnum(r.ad_group_criterion?.keyword?.match_type, MATCH_MAP),
    campaign: r.campaign?.name||"",
    spend: (r.metrics.cost_micros||0)/1e6,
    impressions: r.metrics.impressions||0,
    clicks: r.metrics.clicks||0,
    conversions: r.metrics.conversions||0,
    revenue: r.metrics.conversions_value||0,
    roas: r.metrics.cost_micros>0?(r.metrics.conversions_value||0)/((r.metrics.cost_micros||0)/1e6):0,
    imp_share: parseFloat(r.metrics.search_impression_share||0)*100,
    avg_cpc: (r.metrics.average_cpc||0)/1e6,
  }));

  // Parse asset groups
  const assetGroups = assetRows.map(r => ({
    name: r.asset_group?.name||"",
    campaign: r.campaign?.name||"",
    ad_strength: resolveEnum(r.asset_group?.ad_strength, AD_STRENGTH_MAP),
    spend: (r.metrics.cost_micros||0)/1e6,
    impressions: r.metrics.impressions||0,
    clicks: r.metrics.clicks||0,
    conversions: r.metrics.conversions||0,
    revenue: r.metrics.conversions_value||0,
    roas: r.metrics.cost_micros>0?(r.metrics.conversions_value||0)/((r.metrics.cost_micros||0)/1e6):0,
  }));

  // Parse audiences
  const audiences = audRows.map(r => ({
    user_list: r.ad_group_criterion?.user_list?.user_list||"unknown",
    type: String(r.ad_group_criterion?.type||""),
    campaign: r.campaign?.name||"",
    spend: (r.metrics.cost_micros||0)/1e6,
    impressions: r.metrics.impressions||0,
    clicks: r.metrics.clicks||0,
    conversions: r.metrics.conversions||0,
    revenue: r.metrics.conversions_value||0,
    roas: r.metrics.cost_micros>0?(r.metrics.conversions_value||0)/((r.metrics.cost_micros||0)/1e6):0,
    ctr: (r.metrics.ctr||0)*100,
  }));

  return { campaigns, searchTerms, devices, dayOfWeek, keywords, assetGroups, audiences };
}

// ─── /api/insights ────────────────────────────────────────────────────────────
app.get("/api/insights", async (req, res) => {
  try {
    const { startDate, endDate, prevStartDate, prevEndDate, div } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: "Missing dates" });

    // Build list of [divName, accountId] pairs to fetch
    const tasks = [];
    for (const [d, raw] of Object.entries(DIVISIONS)) {
      if (!raw) continue;
      if (div && div !== "all" && d !== div) continue;
      raw.split(",").map(id => id.trim()).filter(Boolean).forEach(accountId => {
        tasks.push({ divName: d, accountId });
      });
    }

    // Run ALL accounts across ALL divisions in parallel
    const taskResults = await Promise.all(
      tasks.map(({ divName, accountId }) =>
        fetchAccountInsights(accountId, divName, startDate, endDate)
          .then(data => ({ divName, ...data }))
          .catch(e => { console.warn(`Failed ${divName}/${accountId}:`, e.message); return null; })
      )
    );

    // Also fetch previous period totals in parallel (one query per account)
    const prevTasks = tasks.map(({ divName, accountId }) => {
      const cust = getCustomer(accountId);
      return safeQuery(cust,
        `SELECT metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE segments.date BETWEEN '${prevStartDate||startDate}' AND '${prevEndDate||endDate}' AND campaign.status = 'ENABLED' AND metrics.cost_micros > 0`,
        `${divName}/prev`
      ).then(rows => ({ divName, rows }));
    });
    const prevResults = await Promise.all(prevTasks);

    // Merge results by division
    const allData = {};
    const divNames = [...new Set(tasks.map(t => t.divName))];

    for (const divName of divNames) {
      const divResults = taskResults.filter(r => r && r.divName === divName);
      allData[divName] = {
        division: divName,
        campaigns:   divResults.flatMap(r => r.campaigns),
        searchTerms: divResults.flatMap(r => r.searchTerms),
        keywords:    divResults.flatMap(r => r.keywords),
        assetGroups: divResults.flatMap(r => r.assetGroups),
        audiences:   divResults.flatMap(r => r.audiences),
        devices:     mergeDevices(divResults.flatMap(r => r.devices)),
        dayOfWeek:   mergeDow(divResults.flatMap(r => r.dayOfWeek)),
      };
    }

    // Aggregate previous period totals by division
    const prevTotals = {};
    for (const divName of divNames) {
      const divPrev = prevResults.filter(p => p.divName === divName).flatMap(p => p.rows);
      let spend=0,revenue=0,clicks=0,impressions=0,conversions=0;
      divPrev.forEach(r => {
        spend += (r.metrics.cost_micros||0)/1e6;
        impressions += r.metrics.impressions||0;
        clicks += r.metrics.clicks||0;
        conversions += r.metrics.conversions||0;
        revenue += r.metrics.conversions_value||0;
      });
      prevTotals[divName] = { spend, revenue, clicks, impressions, conversions,
        roas: spend>0?revenue/spend:0,
        ctr: impressions>0?(clicks/impressions)*100:0,
        cvr: clicks>0?(conversions/clicks)*100:0,
      };
    }

    res.json({ periods: { current: { startDate, endDate }, previous: { startDate: prevStartDate, endDate: prevEndDate } }, divisions: allData, prevTotals, generatedAt: new Date().toISOString() });

  } catch (err) {
    console.error("Insights API error:", err);
    res.status(500).json({ error: err.message });
  }
});

function mergeDevices(devList) {
  const map = {};
  devList.forEach(d => {
    if (!map[d.device]) map[d.device] = {device:d.device,spend:0,impressions:0,clicks:0,conversions:0,revenue:0};
    map[d.device].spend+=d.spend; map[d.device].impressions+=d.impressions;
    map[d.device].clicks+=d.clicks; map[d.device].conversions+=d.conversions; map[d.device].revenue+=d.revenue;
  });
  return Object.values(map).map(d => ({...d, roas:d.spend>0?d.revenue/d.spend:0, ctr:d.impressions>0?(d.clicks/d.impressions)*100:0, cvr:d.clicks>0?(d.conversions/d.clicks)*100:0}));
}

function mergeDow(dowList) {
  const map = {};
  dowList.forEach(d => {
    if (!map[d.day]) map[d.day] = {day:d.day,spend:0,impressions:0,clicks:0,conversions:0,revenue:0};
    map[d.day].spend+=d.spend; map[d.day].impressions+=d.impressions;
    map[d.day].clicks+=d.clicks; map[d.day].conversions+=d.conversions; map[d.day].revenue+=d.revenue;
  });
  return Object.values(map).map(d => ({...d, roas:d.spend>0?d.revenue/d.spend:0}));
}


// ─── /api/ai-report — proxies to Anthropic API ───────────────────────────────
app.post("/api/ai-report", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: "Missing prompt" });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || "Anthropic API error");
    res.json({ text: data.content?.[0]?.text || "" });
  } catch (err) {
    console.error("AI report error:", err.message);
    res.status(500).json({ error: err.message });
  }
});


// ─── /api/searchterms ─────────────────────────────────────────────────────────
app.get("/api/searchterms", async (req, res) => {
  try {
    const { startDate, endDate, div } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: "Missing dates" });

    const tasks = [];
    for (const [d, raw] of Object.entries(DIVISIONS)) {
      if (!raw) continue;
      if (div && div !== "all" && d !== div) continue;
      raw.split(",").map(id => id.trim()).filter(Boolean).forEach(accountId => {
        tasks.push({ divName: d, accountId });
      });
    }

    const results = await Promise.all(tasks.map(async ({ divName, accountId }) => {
      const cust = getCustomer(accountId);
      const rows = await safeQuery(cust, `
        SELECT search_term_view.search_term, campaign.name,
          campaign.advertising_channel_type, campaign.advertising_channel_sub_type,
          metrics.cost_micros, metrics.impressions, metrics.clicks,
          metrics.conversions, metrics.conversions_value, metrics.ctr
        FROM search_term_view
        WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
          AND metrics.impressions > 5
        ORDER BY metrics.cost_micros DESC LIMIT 200`, `${divName}/searchterms`);

      return rows.map(r => {
        const detected = detectCampaignType(r.campaign?.advertising_channel_type, r.campaign?.advertising_channel_sub_type);
        return {
          term: r.search_term_view?.search_term || "unknown",
          div: divName,
          campaign: r.campaign?.name || "",
          campaign_type: detected.label,
          spend: (r.metrics.cost_micros || 0) / 1e6,
          impressions: r.metrics.impressions || 0,
          clicks: r.metrics.clicks || 0,
          conversions: r.metrics.conversions || 0,
          revenue: r.metrics.conversions_value || 0,
          ctr: (r.metrics.ctr || 0) * 100,
        };
      });
    }));

    res.json({ terms: results.flat(), generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("Search terms error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/assets ──────────────────────────────────────────────────────────────
app.get("/api/assets", async (req, res) => {
  try {
    const { startDate, endDate, div } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: "Missing dates" });

    const ASSET_TYPE_MAP = {
      0:"UNSPECIFIED",1:"UNKNOWN",2:"YOUTUBE_VIDEO",3:"MEDIA_BUNDLE",4:"IMAGE",
      5:"TEXT",6:"LEAD_FORM",7:"BOOK_ON_GOOGLE",8:"PROMOTION",9:"CALLOUT",
      10:"STRUCTURED_SNIPPET",11:"SITELINK",12:"PAGE_FEED",13:"DYNAMIC_EDUCATION",
      14:"MOBILE_APP",15:"HOTEL_CALLOUT",16:"CALL",17:"PRICE",18:"CALL_TO_ACTION",
      19:"DYNAMIC_REAL_ESTATE",20:"DYNAMIC_CUSTOM",21:"DYNAMIC_HOTELS_AND_RENTALS",
      22:"DYNAMIC_FLIGHTS",23:"DISCOVERY_CAROUSEL_CARD",24:"DYNAMIC_TRAVEL",
      25:"DYNAMIC_LOCAL",26:"DYNAMIC_JOBS",27:"LOCATION",28:"HOTEL_PROPERTY",
      29:"HEADLINE",30:"DESCRIPTION",
    };

    const FIELD_TYPE_MAP = {
      0:"UNSPECIFIED",1:"UNKNOWN",2:"HEADLINE",3:"DESCRIPTION",4:"MANDATORY_AD_TEXT",
      5:"MARKETING_IMAGE",6:"SQUARE_MARKETING_IMAGE",7:"LOGO",8:"LANDSCAPE_LOGO",
      9:"CALL_TO_ACTION",10:"YOUTUBE_VIDEO",11:"BUSINESS_NAME",12:"MOBILE_APP",
      13:"HOTEL_CALLOUT",14:"CALL",15:"PRICE",16:"LONG_HEADLINE",17:"BUSINESS_LOGO",
      18:"PORTRAIT_MARKETING_IMAGE",19:"LEAD_FORM",20:"PROMOTION",21:"CALLOUT",
      22:"STRUCTURED_SNIPPET",23:"SITELINK",24:"MOBILE_LOGO",25:"SQUARE_LOGO",
    };

    const PERFORMANCE_MAP = {0:"UNSPECIFIED",1:"UNKNOWN",2:"PENDING",3:"LEARNING",4:"LOW",5:"GOOD",6:"BEST"};

    const tasks = [];
    for (const [d, raw] of Object.entries(DIVISIONS)) {
      if (!raw) continue;
      if (div && div !== "all" && d !== div) continue;
      raw.split(",").map(id => id.trim()).filter(Boolean).forEach(accountId => {
        tasks.push({ divName: d, accountId });
      });
    }

    const results = await Promise.all(tasks.map(async ({ divName, accountId }) => {
      const cust = getCustomer(accountId);

      // Query individual assets within asset groups
      const rows = await safeQuery(cust, `
        SELECT
          asset_group_asset.field_type,
          asset_group_asset.status,
          asset.id,
          asset.name,
          asset.type,
          asset.text_asset.text,
          asset.image_asset.full_size.width_pixels,
          asset.image_asset.full_size.height_pixels,
          asset.youtube_video_asset.youtube_video_title,
          asset.sitelink_asset.link_text,
          asset.sitelink_asset.description1,
          asset.callout_asset.callout_text,
          asset_group.name,
          asset_group.ad_strength,
          campaign.name
        FROM asset_group_asset
        WHERE asset_group_asset.status = 'ENABLED'
        ORDER BY asset_group.name
        LIMIT 1000`, `${divName}/assets`);

      return rows.map(r => {
        const fieldType = resolveEnum(r.asset_group_asset?.field_type, FIELD_TYPE_MAP);
        const assetType = resolveEnum(r.asset?.type, ASSET_TYPE_MAP);
        const performance = 'N/A';

        // Get asset content based on type
        let content = '';
        let assetCategory = fieldType || assetType || 'OTHER';

        if (r.asset?.text_asset?.text) {
          content = r.asset.text_asset.text;
        } else if (r.asset?.sitelink_asset?.link_text) {
          content = r.asset.sitelink_asset.link_text;
          if (r.asset.sitelink_asset.description1) content += ' | ' + r.asset.sitelink_asset.description1;
        } else if (r.asset?.callout_asset?.callout_text) {
          content = r.asset.callout_asset.callout_text;
        } else if (r.asset?.youtube_video_asset?.youtube_video_title) {
          content = r.asset.youtube_video_asset.youtube_video_title;
        } else if (r.asset?.image_asset) {
          const img = r.asset.image_asset;
          content = img.full_size ? `${img.full_size.width_pixels}x${img.full_size.height_pixels}` : 'Image';
        } else if (r.asset?.name) {
          content = r.asset.name;
        }

        // Normalize category for display
        const categoryMap = {
          'HEADLINE': 'Headline', 'LONG_HEADLINE': 'Long Headline',
          'DESCRIPTION': 'Description', 'MARKETING_IMAGE': 'Image',
          'SQUARE_MARKETING_IMAGE': 'Square Image', 'PORTRAIT_MARKETING_IMAGE': 'Portrait Image',
          'LOGO': 'Logo', 'LANDSCAPE_LOGO': 'Landscape Logo',
          'YOUTUBE_VIDEO': 'YouTube Video', 'CALLOUT': 'Callout',
          'SITELINK': 'Sitelink', 'CALL': 'Call', 'CALL_TO_ACTION': 'Call to Action',
          'BUSINESS_NAME': 'Business Name', 'BUSINESS_LOGO': 'Business Logo',
          'STRUCTURED_SNIPPET': 'Structured Snippet', 'PRICE': 'Price',
          'PROMOTION': 'Promotion', 'LEAD_FORM': 'Lead Form',
        };

        return {
          asset_id: r.asset?.id || '',
          asset_name: r.asset?.name || '',
          content,
          asset_group: r.asset_group?.name || '',
          campaign: r.campaign?.name || '',
          div: divName,
          field_type: fieldType,
          asset_type: assetType,
          category: categoryMap[fieldType] || categoryMap[assetType] || fieldType || assetType || 'Other',
          performance,
          ad_strength: resolveEnum(r.asset_group?.ad_strength, {0:"UNSPECIFIED",1:"UNKNOWN",2:"PENDING",3:"NO_ADS",4:"POOR",5:"AVERAGE",6:"GOOD",7:"EXCELLENT"}),
        };
      });
    }));

    const assets = results.flat();

    // Also fetch asset group performance metrics separately
    const perfResults = await Promise.all(tasks.map(async ({ divName, accountId }) => {
      const cust = getCustomer(accountId);
      const rows = await safeQuery(cust, `
        SELECT asset_group.name, asset_group.ad_strength, campaign.name,
          metrics.cost_micros, metrics.impressions, metrics.clicks,
          metrics.conversions, metrics.conversions_value
        FROM asset_group
        WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
          AND asset_group.status = 'ENABLED'
          AND metrics.cost_micros > 0
        ORDER BY metrics.cost_micros DESC LIMIT 100`, `${divName}/assetperf`);

      return rows.map(r => ({
        key: `${divName}||${r.asset_group?.name}`,
        spend: (r.metrics.cost_micros || 0) / 1e6,
        impressions: r.metrics.impressions || 0,
        clicks: r.metrics.clicks || 0,
        conversions: r.metrics.conversions || 0,
        revenue: r.metrics.conversions_value || 0,
      }));
    }));

    // Build perf lookup
    const perfMap = {};
    perfResults.flat().forEach(p => { perfMap[p.key] = p; });

    // Attach group-level metrics to each asset
    const enriched = assets.map(a => {
      const perf = perfMap[`${a.div}||${a.asset_group}`] || {};
      return { ...a, ...perf, key: undefined };
    });

    res.json({ assets: enriched, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error("Assets error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅  Samsung Dashboard running at http://localhost:${PORT}`);
  console.log(`   Divisions configured: ${Object.entries(DIVISIONS).map(([k,v]) => `${k}=${v||'⚠️ missing'}`).join(', ')}\n`);
});
