// This builder keeps the redirect and proxy on the same allow-listed stream URL.
// The fixed TCF value is not collected per listener and is not their consent.
const QUALITIES = Object.freeze({
  64: "fi_suomirap_64.aac",
  128: "fi_suomirap_128.mp3",
});
const STREAM_BASE = "https://live-bauerfi.sharp-stream.com";
const CONSENT =
  "CQrTfsAQrTfsAAGABCENCyFsAP_gAEPAAApAJtQIgAAwAKAAyAB4AIAAVAAyAB4AEAALQAZAA0AByAEWAJgAmgBbADmAH4AQAAggBCACgAGiANkAdwA_QCEAERAMUAZwA_YCZAF5gMZAigBNoBFoA4ACgAHgCEAHcAQgAiIBFgCQkAsACoAHgAQQAyADQAJgAfgBsgDuAH6AYoBeYQACAEUdAMAAWABUAEEAMgA0ACYAH4AaIA2QB-gGKATIAvMeABAIiSgCgALACYANkAxQC8yEAQABYAfgB3AGKKQCwAFgAVABBADIANAAmAB-AGiANkAfoBigF5lQAIACi0AEAdwA.IJtQIwAAwAKAAyAB4AIAAVAAyAB4AEAALQAZAA0AByAEWAJgAmgBbADmAH4AQAAggBCACgAGiANkAdwA_QCEAERAIsAYoAzgB-wEyALzAYyBFACbQAAA.YAAAAAAAAAAA";

export function buildStreamUrl(requestedQuality, nowMs = Date.now()) {
  const quality = Object.hasOwn(QUALITIES, String(requestedQuality))
    ? Number(requestedQuality)
    : 64;
  const skey = Math.floor(nowMs / 1000);
  return (
    `${STREAM_BASE}/${QUALITIES[quality]}?direct=true` +
    `&aw_0_1st.playerid=BMUK_inpage_html5` +
    `&aw_0_1st.skey=${skey}` +
    `&aw_0_1st.bauer_loggedin=false` +
    `&aw_0_req.userConsentV2=${CONSENT}`
  );
}
