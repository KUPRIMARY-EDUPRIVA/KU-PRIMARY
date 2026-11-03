const VALID_SOURCES = new Set(["ku", "kiwanja"]);

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function validateBase64Url(value, field, uid) {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) ||
    Buffer.from(value, "base64").length === 0
  ) {
    throw new Error(`Auth user ${uid} has an invalid ${field}`);
  }
}

function buildImportPlan(source, authUsers, profiles) {
  if (!VALID_SOURCES.has(source)) {
    throw new Error("Source must be ku or kiwanja");
  }
  if (!Array.isArray(authUsers) || !Array.isArray(profiles)) {
    throw new Error(`${source} Auth export or profile data is invalid`);
  }

  const profilesByUid = new Map();
  for (const profile of profiles) {
    if (
      typeof profile.firestore_id !== "string" ||
      !profile.firestore_id ||
      profilesByUid.has(profile.firestore_id)
    ) {
      throw new Error(`${source} has a missing or duplicate profile UID`);
    }
    if (profile.uid !== profile.firestore_id) {
      throw new Error(`${source} profile UID differs from its Firestore document ID`);
    }
    profilesByUid.set(profile.firestore_id, profile);
  }

  const seenUids = new Set();
  const seenEmails = new Set();
  const accounts = authUsers.map((user) => {
    if (typeof user.uid !== "string" || !user.uid || seenUids.has(user.uid)) {
      throw new Error(`${source} Auth export has a missing or duplicate UID`);
    }
    seenUids.add(user.uid);

    const email = normalizeEmail(user.email);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      throw new Error(`${source} Auth user ${user.uid} has an invalid email`);
    }
    if (seenEmails.has(email)) {
      throw new Error(`${source} Auth export contains duplicate email addresses`);
    }
    seenEmails.add(email);

    if (!Array.isArray(user.providerData)) {
      throw new Error(`${source} Auth user ${user.uid} has invalid provider data`);
    }
    const hasPasswordProvider = user.providerData.some(
      (provider) => provider.providerId === "password",
    );
    if (
      !hasPasswordProvider ||
      user.providerData.some((provider) => provider.providerId !== "password")
    ) {
      throw new Error(
        `${source} Auth user ${user.uid} uses an unsupported sign-in provider`,
      );
    }
    if (hasPasswordProvider || user.passwordHash || user.passwordSalt) {
      validateBase64Url(user.passwordHash, "password hash", user.uid);
      validateBase64Url(user.passwordSalt, "password salt", user.uid);
    }

    const profile = profilesByUid.get(user.uid) || null;
    if (
      profile &&
      normalizeEmail(profile.email) !== email
    ) {
      throw new Error(`${source} Auth/profile email mismatch for UID ${user.uid}`);
    }
    return { source, user, email, profile };
  });

  const accountsByUid = new Map(accounts.map((account) => [account.user.uid, account]));
  const unmatchedProfileCount = [...profilesByUid.keys()].filter(
    (uid) => !accountsByUid.has(uid),
  ).length;
  if (unmatchedProfileCount) {
    throw new Error(`${source} has user profiles without matching Auth accounts`);
  }

  const memberships = accounts.flatMap(({ user, profile }) => {
    if (!profile || profile.schoolId == null) return [];
    if (
      typeof profile.schoolId !== "string" ||
      !profile.schoolId ||
      typeof profile.role !== "string" ||
      !profile.role
    ) {
      throw new Error(`${source} profile ${user.uid} has invalid school or role data`);
    }
    return [{
      firebaseUid: user.uid,
      schoolId: profile.schoolId,
      role: profile.role,
    }];
  });

  return {
    source,
    accounts,
    memberships,
    profilelessCount: accounts.filter(({ profile }) => !profile).length,
    profilesWithoutSchoolCount: accounts.filter(
      ({ profile }) => profile && profile.schoolId == null,
    ).length,
    credentialCount: accounts.filter(
      ({ user }) => Boolean(user.passwordHash && user.passwordSalt),
    ).length,
  };
}

function assertNoCrossSourceCollisions(plans) {
  const ownersByEmail = new Map();
  for (const plan of plans) {
    for (const { email } of plan.accounts) {
      const owner = ownersByEmail.get(email);
      if (owner) {
        throw new Error(
          `Auth email collision across ${owner} and ${plan.source}; refusing account merge`,
        );
      }
      ownersByEmail.set(email, plan.source);
    }
  }
}

module.exports = {
  assertNoCrossSourceCollisions,
  buildImportPlan,
  normalizeEmail,
};
