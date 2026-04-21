<?php
/**
 * STILT Squares — cross-user channel backend
 * ------------------------------------------
 * A "channel" is a directional pair of users: FROM -> TO.
 * Tom's "to Ben" box and Ben's "from Tom" box are the SAME file on disk.
 *
 * GET  /api/channel.php?from=<a>&to=<b>   -> returns channel JSON (or {} if none yet)
 * POST /api/channel.php?from=<a>&to=<b>   -> saves request body as channel JSON
 *
 * Storage: ../data/channel-<from>-to-<to>.json
 *
 * Anyone on the team can edit any channel (matches squares.php no-auth model).
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

// --- validate from/to params: only lowercase a-z, 1-20 chars ---
function validUser($u) {
    return preg_match('/^[a-z]{1,20}$/', $u) === 1;
}

$from = isset($_GET['from']) ? strtolower(trim($_GET['from'])) : '';
$to   = isset($_GET['to'])   ? strtolower(trim($_GET['to']))   : '';

if (!validUser($from) || !validUser($to)) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid from/to (a-z only, 1-20 chars)']);
    exit;
}
if ($from === $to) {
    http_response_code(400);
    echo json_encode(['error' => 'from and to must differ']);
    exit;
}

// --- resolve data path, make sure dir exists ---
$dataDir = __DIR__ . '/../data';
if (!is_dir($dataDir)) {
    @mkdir($dataDir, 0755, true);
}
$file = $dataDir . '/channel-' . $from . '-to-' . $to . '.json';

$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    if (!file_exists($file)) {
        echo json_encode(new stdClass()); // empty object -> client falls back to default
        exit;
    }
    $raw = @file_get_contents($file);
    if ($raw === false) {
        http_response_code(500);
        echo json_encode(['error' => 'read failed']);
        exit;
    }
    echo $raw;
    exit;
}

if ($method === 'POST') {
    $raw = file_get_contents('php://input');
    if ($raw === false || strlen($raw) === 0) {
        http_response_code(400);
        echo json_encode(['error' => 'empty body']);
        exit;
    }
    if (strlen($raw) > 1048576) {
        http_response_code(413);
        echo json_encode(['error' => 'payload too large']);
        exit;
    }
    $decoded = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        http_response_code(400);
        echo json_encode(['error' => 'invalid json']);
        exit;
    }
    $tmp = $file . '.tmp.' . bin2hex(random_bytes(4));
    if (@file_put_contents($tmp, $raw, LOCK_EX) === false) {
        http_response_code(500);
        echo json_encode(['error' => 'write failed']);
        exit;
    }
    if (!@rename($tmp, $file)) {
        @unlink($tmp);
        http_response_code(500);
        echo json_encode(['error' => 'rename failed']);
        exit;
    }
    echo json_encode(['ok' => true, 'from' => $from, 'to' => $to, 'saved_at' => date('c')]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'method not allowed']);
