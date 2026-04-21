<?php
/**
 * STILT Squares — bulk view loader
 * --------------------------------
 * GET /api/view.php?user=<name>&peers=ben,jeffery,tyler,...
 *
 * Returns everything needed to render <name>'s board in a single request:
 *   {
 *     user: "tom",
 *     personal:  { ...squares-tom.json... },
 *     outbound:  { ben: {...}, jeffery: {...}, ... },   // tom -> peer
 *     inbound:   { ben: {...}, jeffery: {...}, ... }    // peer -> tom
 *   }
 *
 * Missing files come back as {} so the client can fall back to defaults.
 * Keeps tasks.html from making N+1 round trips on page load.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function validUser($u) {
    return preg_match('/^[a-z]{1,20}$/', $u) === 1;
}

function readJsonOrEmpty($path) {
    if (!file_exists($path)) return new stdClass();
    $raw = @file_get_contents($path);
    if ($raw === false || $raw === '') return new stdClass();
    $decoded = json_decode($raw);
    if ($decoded === null && json_last_error() !== JSON_ERROR_NONE) {
        return new stdClass();
    }
    return $decoded;
}

$user = isset($_GET['user']) ? strtolower(trim($_GET['user'])) : '';
if (!validUser($user)) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid user']);
    exit;
}

$peersRaw = isset($_GET['peers']) ? trim($_GET['peers']) : '';
$peers = [];
if ($peersRaw !== '') {
    foreach (explode(',', $peersRaw) as $p) {
        $p = strtolower(trim($p));
        if ($p === '' || $p === $user) continue;
        if (!validUser($p)) {
            http_response_code(400);
            echo json_encode(['error' => 'invalid peer: ' . $p]);
            exit;
        }
        $peers[] = $p;
    }
    // dedupe, cap at 50 peers so this never blows up
    $peers = array_slice(array_values(array_unique($peers)), 0, 50);
}

$dataDir = __DIR__ . '/../data';
if (!is_dir($dataDir)) {
    @mkdir($dataDir, 0755, true);
}

$personal  = readJsonOrEmpty($dataDir . '/squares-' . $user . '.json');
$outbound  = new stdClass();
$inbound   = new stdClass();

foreach ($peers as $peer) {
    $outbound->{$peer} = readJsonOrEmpty($dataDir . '/channel-' . $user . '-to-' . $peer . '.json');
    $inbound->{$peer}  = readJsonOrEmpty($dataDir . '/channel-' . $peer . '-to-' . $user . '.json');
}

echo json_encode([
    'user'     => $user,
    'personal' => $personal,
    'outbound' => $outbound,
    'inbound'  => $inbound,
    'loaded_at'=> date('c'),
]);
