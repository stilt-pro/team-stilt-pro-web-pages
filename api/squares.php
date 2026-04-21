<?php
/**
 * STILT Squares backend
 * ---------------------
 * GET  /api/squares.php?user=<name>   -> returns that user's JSON (or {} if none yet)
 * POST /api/squares.php?user=<name>   -> saves request body as that user's JSON
 *
 * Storage: ../data/squares-<name>.json  (sibling folder, outside api/)
 *
 * No auth: internal team hub only. If that changes, add a shared token check.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

// --- validate user param: only lowercase a-z, 1-20 chars ---
$user = isset($_GET['user']) ? strtolower(trim($_GET['user'])) : '';
if (!preg_match('/^[a-z]{1,20}$/', $user)) {
    http_response_code(400);
    echo json_encode(['error' => 'invalid user (a-z only, 1-20 chars)']);
    exit;
}

// --- resolve data path, make sure dir exists ---
$dataDir = __DIR__ . '/../data';
if (!is_dir($dataDir)) {
    @mkdir($dataDir, 0755, true);
}
$file = $dataDir . '/squares-' . $user . '.json';

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
    // reject absurdly large payloads (1 MB is way more than needed)
    if (strlen($raw) > 1048576) {
        http_response_code(413);
        echo json_encode(['error' => 'payload too large']);
        exit;
    }
    // validate it's real JSON
    $decoded = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        http_response_code(400);
        echo json_encode(['error' => 'invalid json']);
        exit;
    }
    // atomic-ish write: temp file then rename
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
    echo json_encode(['ok' => true, 'user' => $user, 'saved_at' => date('c')]);
    exit;
}

http_response_code(405);
echo json_encode(['error' => 'method not allowed']);
