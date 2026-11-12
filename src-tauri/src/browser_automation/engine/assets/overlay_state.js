// How many agent overlays hang off <html>, and whether the first shows:
// the conformance suite's probe of the overlay around a capture.
var root = docElOf(document);
var hosts = root ? QSA[1](root, ':scope > termul-agent-overlay') : [];
return {
  count: hosts.length,
  visible: hosts.length > 0 && styleOf(hosts[0]).visibility !== 'hidden'
};
