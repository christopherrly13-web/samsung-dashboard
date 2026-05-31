require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { GoogleAdsApi } = require("google-ads-api");

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

// ─── Numeric enum resolver ────────────────────────────────────────────────────
function resolveEnum(val, map) {
  if (val === undefined || val === null) return "UNSPECIFIED";
  if (typeof val === "string" && isNaN(val)) return val;
  return map[Number(val)] || String(val);
}

// ─── Channel type → campaign type label ──────────────────────────────────────
const CHANNEL_TYPE_MAP = {
  0:"UNSPECIFIED",1:"UNKNOWN",2:"SEARCH",3:"DISPLAY",
  4:"SHOPPING",5:"HOTEL",6:"VIDEO",7:"MULTI_CHANNEL",
  8:"LOCAL",9:"SMART",10:"PERFORMANCE_MAX",11:"LOCAL_SERVICES",
  12:"DISCOVERY",13:"TRAVEL",
};
const CHANNEL_SUB_MAP = {
  0:"UNSPECIFIED",1:"UNKNOWN",2:"SEARCH_MOBILE_APP",3:"DISPLAY_MOBILE_APP",
  4:"SEARCH_EXPRESS",5:"DISPLAY_EXPRESS",6:"SHOPPING_SMART_ADS",
  7:"DISPLAY_GMAIL_AD",8:"DISPLAY_SMART_CAMPAIGN",9:"VIDEO_OUTSTREAM",
  10:"VIDEO_ACTION",11:"VIDEO_NON_SKIPPABLE",12:"APP_CAMPAIGN",
  13:"APP_CAMPAIGN_FOR_ENGAGEMENT",14:"LOCAL_CAMPAIGN",15:"SHOPPING_COMPARISON_LISTING_ADS",
  16:"SMART_CAMPAIGN",17:"VIDEO_SEQUENCE",
};

function detectCampaignType(channelType, channelSubType) {
  const ct = typeof channelType === "number" ? CHANNEL_TYPE_MAP[channelType] : channelType;
  const cs = typeof channelSubType === "number" ? CHANNEL_SUB_MAP[channelSubType] : channelSubType;
  switch (ct) {
    case "SEARCH":          return { label: "Text",     color: "#4285f4" };
    case "SHOPPING":        return { label: "Shopping", color: "#34a853" };
    case "PERFORMANCE_MAX": return { label: "Pmax",     color: "#fbbc05" };
    case "MULTI_CHANNEL":
      if (cs === "APP_CAMPAIGN_FOR_ENGAGEMENT") return { label: "Shop App", color: "#ea4335" };
      if (cs === "APP_CAMPAIGN")                return { label: "Shop App", color: "#ea4335" };
      return { label: "App", color: "#ea4335" };
    case "DISPLAY":         return { label: "Display",  color: "#9c27b0" };
    case "VIDEO":           return { label: "Video",    color: "#ff5722" };
    case "SMART":           return { label: "Smart",    color: "#607d8b" };
    case "LOCAL":           return { label: "Local",    color: "#795548" };
    case "LOCAL_SERVICES":  return { label: "Local Svc",color: "#009688" };
    case "DISCOVERY":       return { label: "Discovery",color: "#e91e63" };
    default:                return { label: ct || "Other", color: "#9e9e9e" };
  }
}

// ─── Helper: get customer object ──────────────────────────────────────────────
function getCustomer(accountId) {
  return client.Customer({
    customer_id: accountId.replace(/-/g, ""),
    refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    login_customer_id: process.env.GOOGLE_ADS_MCC_ID?.replace(/-/g, ""),
  });
}

// ─── Safe query wrapper ───────────────────────────────────────────────────────
async function safeQuery(customer, gaql, label) {
  try { return await customer.query(gaql); }
  catch(e) {
    console.warn(`[${label}] skipped:`, e?.message || JSON.stringify(e)?.slice(0, 300));
    return [];
  }
}

// ─── Build tasks list for given div filter ────────────────────────────────────
function buildTasks(divFilter) {
  const tasks = [];
  for (const [d, raw] of Object.entries(DIVISIONS)) {
    if (!raw) continue;
    if (divFilter && divFilter !== "all" && d !== divFilter) continue;
    raw.split(",").map(id => id.trim()).filter(Boolean).forEach(accountId => {
      tasks.push({ divName: d, accountId });
    });
  }
  return tasks;
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// ─── /api/accounts ────────────────────────────────────────────────────────────
app.get("/api/accounts", async (req, res) => {
  try {
    const results = await Promise.all(
      Object.entries(DIVISIONS).map(async ([divName, raw]) => {
        if (!raw) return { div: divName, status: "not configured", accounts: [] };
        const ids = raw.split(",").map(id => id.trim()).filter(Boolean);
        const accountStatuses = await Promise.all(ids.map(async accountId => {
          try {
            const cust = getCustomer(accountId);
            await cust.query(`SELECT customer.id FROM customer LIMIT 1`);
            return { id: accountId, status: "ok" };
          } catch(e) {
            return { id: accountId, status: "error", error: e?.message || String(e) };
          }
        }));
        const allOk = accountStatuses.every(a => a.status === "ok");
        return { div: divName, status: allOk ? "ok" : "error", accounts: accountStatuses };
      })
    );
    res.json({ divisions: results });
  } catch(err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/summary ─────────────────────────────────────────────────────────────
app.get("/api/summary", async (req, res) => {
  try {
    const { startDate, endDate, prevStartDate, prevEndDate, div } = req.query;
    if (!startDate || !endDate || !prevStartDate || !prevEndDate)
      return res.status(400).json({ error: "Missing date params." });

    const tasks = buildTasks(div);

    const [curResults, prevResults] = await Promise.all([
      Promise.all(tasks.map(async ({ divName, accountId }) => {
        const cust = getCustomer(accountId);
        const rows = await safeQuery(cust, `
          SELECT
            campaign.advertising_channel_type,
            campaign.advertising_channel_sub_type,
            metrics.cost_micros,
            metrics.impressions,
            metrics.clicks,
            metrics.conversions,
            metrics.conversions_value
          FROM campaign
          WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
            AND campaign.status = 'ENABLED'
        `, `${divName}/summary`);
        return { divName, rows };
      })),
      Promise.all(tasks.map(async ({ divName, accountId }) => {
        const cust = getCustomer(accountId);
        const rows = await safeQuery(cust, `
          SELECT
            metrics.cost_micros,
            metrics.impressions,
            metrics.clicks,
            metrics.conversions,
            metrics.conversions_value
          FROM campaign
          WHERE segments.date BETWEEN '${prevStartDate}' AND '${prevEndDate}'
            AND campaign.status = 'ENABLED'
        `, `${divName}/summary-prev`);
        return { divName, rows };
      })),
    ]);

    // Aggregate by division
    const agg = (results) => {
      const byDiv = {};
      results.forEach(({ divName, rows }) => {
        if (!byDiv[divName]) byDiv[divName] = { spend:0, impressions:0, clicks:0, conversions:0, revenue:0, byType:{} };
        rows.forEach(r => {
          const m = r.metrics || {};
          byDiv[divName].spend       += (m.cost_micros || 0) / 1e6;
          byDiv[divName].impressions += m.impressions || 0;
          byDiv[divName].clicks      += m.clicks || 0;
          byDiv[divName].conversions += m.conversions || 0;
          byDiv[divName].revenue     += m.conversions_value || 0;
          const type = detectCampaignType(r.campaign?.advertising_channel_type, r.campaign?.advertising_channel_sub_type).label;
          if (!byDiv[divName].byType[type]) byDiv[divName].byType[type] = { spend:0, impressions:0, clicks:0, conversions:0, revenue:0 };
          byDiv[divName].byType[type].spend       += (m.cost_micros || 0) / 1e6;
          byDiv[divName].byType[type].impressions += m.impressions || 0;
          byDiv[divName].byType[type].clicks      += m.clicks || 0;
          byDiv[divName].byType[type].conversions += m.conversions || 0;
          byDiv[divName].byType[type].revenue     += m.conversions_value || 0;
        });
      });
      return byDiv;
    };

    const cur  = agg(curResults);
    const prev = agg(prevResults);

    res.json({ current: cur, previous: prev, generatedAt: new Date().toISOString() });
  } catch(err) {
    console.error("Summary error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/campaigns ───────────────────────────────────────────────────────────
app.get("/api/campaigns", async (req, res) => {
  try {
    const { startDate, endDate, prevStartDate, prevEndDate, div } = req.query;
    if (!startDate || !endDate || !prevStartDate || !prevEndDate)
      return res.status(400).json({ error: "Missing date params." });

    const tasks = buildTasks(div);

    const query = (sd, ed, label) => Promise.all(tasks.map(async ({ divName, accountId }) => {
      const cust = getCustomer(accountId);
      const rows = await safeQuery(cust, `
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
        WHERE segments.date BETWEEN '${sd}' AND '${ed}'
          AND campaign.status = 'ENABLED'
        ORDER BY metrics.cost_micros DESC
      `, `${divName}/${label}`);
      return rows.map(r => {
        const m = r.metrics || {};
        const detected = detectCampaignType(r.campaign?.advertising_channel_type, r.campaign?.advertising_channel_sub_type);
        return {
          id:          r.campaign?.id || "",
          name:        r.campaign?.name || "",
          div:         divName,
          type:        detected.label,
          color:       detected.color,
          spend:       (m.cost_micros || 0) / 1e6,
          impressions: m.impressions || 0,
          clicks:      m.clicks || 0,
          conversions: m.conversions || 0,
          revenue:     m.conversions_value || 0,
          ctr:         m.impressions > 0 ? (m.clicks / m.impressions) * 100 : 0,
          cpa:         m.conversions > 0 ? ((m.cost_micros || 0) / 1e6) / m.conversions : 0,
          roas:        m.cost_micros > 0 ? (m.conversions_value || 0) / ((m.cost_micros || 0) / 1e6) : 0,
          impression_share:        (m.search_impression_share || 0) * 100,
          top_impression_share:    (m.search_top_impression_share || 0) * 100,
          abs_top_impression_share:(m.search_absolute_top_impression_share || 0) * 100,
          budget_lost_is:          (m.search_budget_lost_impression_share || 0) * 100,
          rank_lost_is:            (m.search_rank_lost_impression_share || 0) * 100,
        };
      });
    }));

    const [curRows, prevRows] = await Promise.all([
      query(startDate, endDate, "campaigns"),
      query(prevStartDate, prevEndDate, "campaigns-prev"),
    ]);

    // Build prev lookup by campaign id
    const prevMap = {};
    prevRows.flat().forEach(r => { prevMap[`${r.div}||${r.id}`] = r; });

    const campaigns = curRows.flat().map(r => {
      const p = prevMap[`${r.div}||${r.id}`] || {};
      return {
        ...r,
        prev_spend:       p.spend || 0,
        prev_conversions: p.conversions || 0,
        prev_revenue:     p.revenue || 0,
        prev_roas:        p.roas || 0,
      };
    });

    res.json({ campaigns, generatedAt: new Date().toISOString() });
  } catch(err) {
    console.error("Campaigns error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/searchterms ─────────────────────────────────────────────────────────
app.get("/api/searchterms", async (req, res) => {
  try {
    const { startDate, endDate, div } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: "Missing dates" });

    const tasks = buildTasks(div);

    const results = await Promise.all(tasks.map(async ({ divName, accountId }) => {
      const cust = getCustomer(accountId);
      const rows = await safeQuery(cust, `
        SELECT
          search_term_view.search_term,
          campaign.name,
          campaign.advertising_channel_type,
          campaign.advertising_channel_sub_type,
          metrics.cost_micros,
          metrics.impressions,
          metrics.clicks,
          metrics.conversions,
          metrics.conversions_value,
          metrics.ctr
        FROM search_term_view
        WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
          AND metrics.impressions > 5
        ORDER BY metrics.cost_micros DESC LIMIT 200
      `, `${divName}/searchterms`);

      return rows.map(r => {
        const detected = detectCampaignType(r.campaign?.advertising_channel_type, r.campaign?.advertising_channel_sub_type);
        const m = r.metrics || {};
        return {
          term:          r.search_term_view?.search_term || "unknown",
          div:           divName,
          campaign:      r.campaign?.name || "",
          campaign_type: detected.label,
          spend:         (m.cost_micros || 0) / 1e6,
          impressions:   m.impressions || 0,
          clicks:        m.clicks || 0,
          conversions:   m.conversions || 0,
          revenue:       m.conversions_value || 0,
          ctr:           (m.ctr || 0) * 100,
        };
      });
    }));

    res.json({ terms: results.flat(), generatedAt: new Date().toISOString() });
  } catch(err) {
    console.error("Search terms error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/assets ──────────────────────────────────────────────────────────────
// Two-step: (1) fetch asset groups WITH spend in date range,
// (2) fetch individual assets and filter to those active groups only.
// This fixes MX where PMax asset groups don't always surface cost_micros
// at the group level — we use campaign-level spend as a fallback signal.
app.get("/api/assets", async (req, res) => {
  try {
    const { startDate, endDate, div } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: "Missing dates" });

    const AD_STRENGTH_MAP = {0:"UNSPECIFIED",1:"UNKNOWN",2:"PENDING",3:"NO_ADS",4:"POOR",5:"AVERAGE",6:"GOOD",7:"EXCELLENT"};

    const categoryMap = {
      HEADLINE:                 "Headline",
      DESCRIPTION:              "Description",
      MARKETING_IMAGE:          "Image",
      SQUARE_MARKETING_IMAGE:   "Image",
      PORTRAIT_MARKETING_IMAGE: "Image",
      LOGO:                     "Logo",
      SQUARE_LOGO:              "Logo",
      YOUTUBE_VIDEO:            "Video",
      CALL_TO_ACTION:           "Call to Action",
      BUSINESS_NAME:            "Business Name",
      BUSINESS_LOGO:            "Business Logo",
      CALLOUT:                  "Callout",
      SITELINK:                 "Sitelink",
      STRUCTURED_SNIPPET:       "Structured Snippet",
      PROMOTION:                "Promotion",
      PRICE:                    "Price",
      LEAD_FORM:                "Lead Form",
      IMAGE:                    "Image",
      TEXT:                     "Text",
    };

    const tasks = buildTasks(div);

    const results = await Promise.all(tasks.map(async ({ divName, accountId }) => {
      const cust = getCustomer(accountId);

      // ── Step 1: Get asset groups that had spend in the date range ──────────
      // Paginate to handle accounts with many asset groups (MX has 100+)
      let perfRows = [];
      let offset = 0;
      const PAGE = 500;
      while (true) {
        const page = await safeQuery(cust, `
          SELECT
            asset_group.resource_name,
            asset_group.name,
            asset_group.ad_strength,
            campaign.name,
            metrics.cost_micros,
            metrics.impressions,
            metrics.clicks,
            metrics.conversions,
            metrics.conversions_value
          FROM asset_group
          WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
            AND asset_group.status = 'ENABLED'
            AND metrics.impressions > 0
          ORDER BY metrics.cost_micros DESC
          LIMIT ${PAGE} OFFSET ${offset}
        `, `${divName}/assetgroups-p${offset}`);
        perfRows = perfRows.concat(page);
        if (page.length < PAGE) break;
        offset += PAGE;
        if (offset > 2000) break; // safety cap
      }

      // ── Step 1b: If no asset groups had impressions (can happen for PMax
      //    in some MCC setups), fall back to ANY enabled asset groups ─────────
      let activeGroupNames = new Set(perfRows.map(r => r.asset_group?.name).filter(Boolean));
      const perfByName = {};
      perfRows.forEach(r => {
        const name = r.asset_group?.name;
        if (!name) return;
        perfByName[name] = {
          ad_strength: r.asset_group?.ad_strength,
          campaign:    r.campaign?.name,
          spend:       (r.metrics?.cost_micros || 0) / 1e6,
          impressions: r.metrics?.impressions || 0,
          clicks:      r.metrics?.clicks || 0,
          conversions: r.metrics?.conversions || 0,
          revenue:     r.metrics?.conversions_value || 0,
        };
      });

      // If no active groups found at asset_group level, try campaign-level
      // to check if MX account has any spend at all in this period
      if (activeGroupNames.size === 0) {
        const campRows = await safeQuery(cust, `
          SELECT campaign.name, metrics.cost_micros, metrics.impressions
          FROM campaign
          WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
            AND campaign.status = 'ENABLED'
            AND metrics.impressions > 0
          ORDER BY metrics.cost_micros DESC LIMIT 10
        `, `${divName}/camp-check`);

        if (campRows.length === 0) {
          // Account has zero impressions in this period — return empty
          return [];
        }

        // Account has spend but asset_group-level query returned nothing.
        // This happens in some MCC/PMax configs. Fetch all enabled asset
        // groups (no spend filter) so at least assets are shown.
        const allGroupRows = await safeQuery(cust, `
          SELECT asset_group.name, asset_group.ad_strength, campaign.name
          FROM asset_group
          WHERE asset_group.status = 'ENABLED'
          LIMIT 500
        `, `${divName}/assetgroups-fallback`);

        allGroupRows.forEach(r => {
          const name = r.asset_group?.name;
          if (!name) return;
          activeGroupNames.add(name);
          if (!perfByName[name]) {
            perfByName[name] = {
              ad_strength: r.asset_group?.ad_strength,
              campaign:    r.campaign?.name,
              spend:       0,
              impressions: 0,
              clicks:      0,
              conversions: 0,
              revenue:     0,
            };
          }
        });
      }

      if (activeGroupNames.size === 0) return [];

      // ── Step 2: Fetch individual assets WITH metrics per asset ─────────────
      // asset_group_asset now supports quantitative metrics (clicks, impressions,
      // conversions) segmented by date — this replaced the removed performance_label.
      // Note: metrics here are per-asset within the group, giving true variance.
      let assetRows = [];
      let assetOffset = 0;
      const ASSET_PAGE = 1000;
      while (true) {
        const page = await safeQuery(cust, `
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
            campaign.name,
            metrics.impressions,
            metrics.clicks,
            metrics.conversions,
            metrics.conversions_value,
            metrics.cost_micros,
            metrics.ctr
          FROM asset_group_asset
          WHERE asset_group_asset.status = 'ENABLED'
            AND segments.date BETWEEN '${startDate}' AND '${endDate}'
          ORDER BY metrics.impressions DESC
          LIMIT ${ASSET_PAGE} OFFSET ${assetOffset}
        `, `${divName}/assets-p${assetOffset}`);
        assetRows = assetRows.concat(page);
        if (page.length < ASSET_PAGE) break;
        assetOffset += ASSET_PAGE;
        if (assetOffset > 10000) break;
      }

      // If the metrics query returned nothing (some API versions don't support
      // date segmentation on asset_group_asset), fall back to no-metrics query
      if (assetRows.length === 0) {
        let fallbackOffset = 0;
        while (true) {
          const page = await safeQuery(cust, `
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
            LIMIT ${ASSET_PAGE} OFFSET ${fallbackOffset}
          `, `${divName}/assets-fallback-p${fallbackOffset}`);
          assetRows = assetRows.concat(page);
          if (page.length < ASSET_PAGE) break;
          fallbackOffset += ASSET_PAGE;
          if (fallbackOffset > 10000) break;
        }
      }

      // ── Step 3: Filter to active groups and build output rows ─────────────
      const PRIMARY_STATUS_MAP = {
        0:"UNSPECIFIED",1:"UNKNOWN",2:"ELIGIBLE",3:"PAUSED",4:"REMOVED",
        5:"PENDING",6:"LIMITED",7:"LEARNING",8:"NOT_ELIGIBLE",
      };

      return assetRows
        .filter(r => activeGroupNames.has(r.asset_group?.name))
        .map(r => {
          const fieldType = resolveEnum(r.asset_group_asset?.field_type, {
            0:"UNSPECIFIED",1:"UNKNOWN",2:"HEADLINE",3:"DESCRIPTION",
            4:"MARKETING_IMAGE",5:"SQUARE_MARKETING_IMAGE",6:"LOGO",
            7:"YOUTUBE_VIDEO",8:"CALL_TO_ACTION",9:"BUSINESS_NAME",
            10:"BUSINESS_LOGO",11:"CALLOUT",12:"STRUCTURED_SNIPPET",
            13:"PROMOTION",14:"PRICE",15:"SQUARE_LOGO",16:"LEAD_FORM",
            17:"IMAGE",18:"PORTRAIT_MARKETING_IMAGE",19:"SITELINK",
            20:"MOBILE_APP",
          });

          const assetType = resolveEnum(r.asset?.type, {
            0:"UNSPECIFIED",1:"UNKNOWN",2:"YOUTUBE_VIDEO",3:"MEDIA_BUNDLE",
            4:"IMAGE",5:"TEXT",6:"LEAD_FORM",7:"BOOK_ON_GOOGLE",
            8:"PROMOTION",9:"CALLOUT",10:"STRUCTURED_SNIPPET",11:"SITELINK",
            12:"PAGE_FEED",13:"DYNAMIC_EDUCATION",14:"MOBILE_APP",
            15:"HOTEL_CALLOUT",16:"CALL",17:"PRICE",18:"CALL_TO_ACTION",
            19:"DYNAMIC_REAL_ESTATE",20:"DYNAMIC_CUSTOM",21:"DYNAMIC_HOTELS_AND_RENTALS",
            22:"DYNAMIC_FLIGHTS",23:"DISCOVERY_CAROUSEL_CARD",24:"DYNAMIC_TRAVEL",
            25:"DYNAMIC_LOCAL",26:"DYNAMIC_JOBS",27:"LOCATION",28:"HOTEL_PROPERTY",
            29:"DEMAND_GEN_CAROUSEL_CARD",30:"BUSINESS_MESSAGE",
          });

          // Derive human-readable content from the asset
          let content = "";
          if (r.asset?.text_asset?.text)                            content = r.asset.text_asset.text;
          else if (r.asset?.youtube_video_asset?.youtube_video_title) content = r.asset.youtube_video_asset.youtube_video_title;
          else if (r.asset?.sitelink_asset?.link_text)              content = r.asset.sitelink_asset.link_text;
          else if (r.asset?.callout_asset?.callout_text)            content = r.asset.callout_asset.callout_text;
          else if (r.asset?.image_asset?.full_size?.width_pixels) {
            const w = r.asset.image_asset.full_size.width_pixels;
            const h = r.asset.image_asset.full_size.height_pixels;
            content = `${w}x${h}`;
          }

          const grpName = r.asset_group?.name || "";
          const perf    = perfByName[grpName] || {};
          const m       = r.metrics || {};

          // Per-asset metrics (from asset_group_asset with date segmentation)
          const assetImpressions = m.impressions || 0;
          const assetClicks      = m.clicks || 0;
          const assetConversions = m.conversions || 0;
          const assetRevenue     = m.conversions_value || 0;
          const assetSpend       = (m.cost_micros || 0) / 1e6;
          const assetCtr         = m.ctr ? (m.ctr * 100) : (assetImpressions > 0 ? (assetClicks / assetImpressions) * 100 : 0);
          const assetRoas        = assetSpend > 0 ? assetRevenue / assetSpend : 0;


          return {
            asset_id:   r.asset?.id   || "",
            asset_name: r.asset?.name || "",
            content,
            asset_group:  grpName,
            campaign:     perf.campaign || r.campaign?.name || "",
            div:          divName,
            field_type:   fieldType,
            asset_type:   assetType,
            category:     categoryMap[fieldType] || categoryMap[assetType] || fieldType || "Other",
            ad_strength:  resolveEnum(
              perf.ad_strength ?? r.asset_group?.ad_strength,
              AD_STRENGTH_MAP
            ),
            // Per-asset metrics (true variance between assets in same group)
            asset_impressions: assetImpressions,
            asset_clicks:      assetClicks,
            asset_conversions: assetConversions,
            asset_revenue:     assetRevenue,
            asset_spend:       assetSpend,
            asset_ctr:         assetCtr,
            asset_roas:        assetRoas,
            // Group-level metrics (same for all assets in the group)
            group_spend:       perf.spend       || 0,
            group_impressions: perf.impressions || 0,
            group_clicks:      perf.clicks      || 0,
            group_conversions: perf.conversions || 0,
            group_revenue:     perf.revenue     || 0,
          };
        });
    }));

    res.json({ assets: results.flat(), generatedAt: new Date().toISOString() });
  } catch(err) {
    console.error("Assets error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── /api/insights ────────────────────────────────────────────────────────────
app.get("/api/insights", async (req, res) => {
  try {
    const { startDate, endDate, prevStartDate, prevEndDate, div } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ error: "Missing dates" });

    const tasks = buildTasks(div);
    const DEVICE_MAP = {0:"UNSPECIFIED",1:"UNKNOWN",2:"MOBILE",3:"TABLET",4:"DESKTOP",5:"CONNECTED_TV",6:"OTHER"};
    const DOW_MAP    = {0:"UNSPECIFIED",1:"MONDAY",2:"TUESDAY",3:"WEDNESDAY",4:"THURSDAY",5:"FRIDAY",6:"SATURDAY",7:"SUNDAY"};

    const allData = await Promise.all(tasks.map(async ({ divName, accountId }) => {
      const cust = getCustomer(accountId);

      const [campRows, deviceRows, dowRows, termRows] = await Promise.all([
        safeQuery(cust, `
          SELECT campaign.name, campaign.advertising_channel_type, campaign.advertising_channel_sub_type,
            metrics.cost_micros, metrics.impressions, metrics.clicks,
            metrics.conversions, metrics.conversions_value
          FROM campaign
          WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
            AND campaign.status = 'ENABLED'
          ORDER BY metrics.cost_micros DESC LIMIT 50
        `, `${divName}/insights-camp`),

        safeQuery(cust, `
          SELECT segments.device, metrics.cost_micros, metrics.impressions,
            metrics.clicks, metrics.conversions, metrics.conversions_value
          FROM campaign
          WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
            AND campaign.status = 'ENABLED'
        `, `${divName}/insights-device`),

        safeQuery(cust, `
          SELECT segments.day_of_week, metrics.cost_micros, metrics.impressions,
            metrics.clicks, metrics.conversions, metrics.conversions_value
          FROM campaign
          WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
            AND campaign.status = 'ENABLED'
        `, `${divName}/insights-dow`),

        safeQuery(cust, `
          SELECT search_term_view.search_term, metrics.cost_micros, metrics.impressions,
            metrics.clicks, metrics.conversions, metrics.conversions_value
          FROM search_term_view
          WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'
            AND metrics.impressions > 10
          ORDER BY metrics.cost_micros DESC LIMIT 100
        `, `${divName}/insights-terms`),
      ]);

      return {
        div: divName,
        campaigns: campRows.map(r => {
          const m = r.metrics || {};
          const dt = detectCampaignType(r.campaign?.advertising_channel_type, r.campaign?.advertising_channel_sub_type);
          return { name: r.campaign?.name, type: dt.label, spend: (m.cost_micros||0)/1e6,
            impressions: m.impressions||0, clicks: m.clicks||0, conversions: m.conversions||0, revenue: m.conversions_value||0 };
        }),
        devices: Object.values(deviceRows.reduce((acc, r) => {
          const dev = resolveEnum(r.segments?.device, DEVICE_MAP);
          const m   = r.metrics || {};
          if (!acc[dev]) acc[dev] = { device: dev, spend:0, impressions:0, clicks:0, conversions:0, revenue:0 };
          acc[dev].spend       += (m.cost_micros||0)/1e6;
          acc[dev].impressions += m.impressions||0;
          acc[dev].clicks      += m.clicks||0;
          acc[dev].conversions += m.conversions||0;
          acc[dev].revenue     += m.conversions_value||0;
          return acc;
        }, {})),
        dayOfWeek: Object.values(dowRows.reduce((acc, r) => {
          const dow = resolveEnum(r.segments?.day_of_week, DOW_MAP);
          const m   = r.metrics || {};
          if (!acc[dow]) acc[dow] = { day: dow, spend:0, impressions:0, clicks:0, conversions:0, revenue:0 };
          acc[dow].spend       += (m.cost_micros||0)/1e6;
          acc[dow].impressions += m.impressions||0;
          acc[dow].clicks      += m.clicks||0;
          acc[dow].conversions += m.conversions||0;
          acc[dow].revenue     += m.conversions_value||0;
          return acc;
        }, {})),
        searchTerms: termRows.map(r => {
          const m = r.metrics || {};
          return { term: r.search_term_view?.search_term, spend:(m.cost_micros||0)/1e6,
            impressions:m.impressions||0, clicks:m.clicks||0, conversions:m.conversions||0, revenue:m.conversions_value||0 };
        }),
      };
    }));

    res.json({ insights: allData, generatedAt: new Date().toISOString() });
  } catch(err) {
    console.error("Insights error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve frontend ───────────────────────────────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

// ─── Global error handler — never let a bad request crash the process ────────
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: err.message || "Internal server error" });
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Samsung Ads Dashboard running on port ${PORT}`));
