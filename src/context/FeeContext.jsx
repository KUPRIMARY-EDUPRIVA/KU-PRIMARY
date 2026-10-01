// src/context/FeeContext.jsx

import React, {
    createContext,
    useContext,
    useState,
    useEffect,
    useCallback,
    useMemo
} from 'react';

import { useAuth } from './AuthContext';
import { useSync } from './SyncContext';

import {
    requireSchoolId,
    getStudentsPage,
    countStudents,
    getFeeTransactions,
    getInvoices,
    getBalancesForSchool,
    createInvoicesBatch,
    postTransaction,
    voidTransaction,
    getInvoiceSummary,
    isTermLocked,
    computeAging,
    getFeeStructures,
    upsertFeeStructure,
    deleteFeeStructure,
    reconcileStudentBalance,
    cancelInvoice
} from '../services/feeService';

import { setMemory } from '../services/cache';

const FeeContext = createContext();

export function useFee() {
    const ctx = useContext(FeeContext);

    if (!ctx) {
        throw new Error(
            'useFee must be used within a FeeProvider'
        );
    }

    return ctx;
}

const generateInvoiceNumber = (
    schoolId,
    seq
) => {
    const prefix =
        (schoolId || 'SCH')
            .substring(0, 4)
            .toUpperCase();

    const d = new Date();

    const stamp =
        `${d.getFullYear()}${String(
            d.getMonth() + 1
        ).padStart(2, '0')}${String(
            d.getDate()
        ).padStart(2, '0')}`;

    return `${prefix}-INV-${stamp}-${String(
        seq % 10000
    ).padStart(4, '0')}`;
};

export function FeeProvider({
    children
}) {
    const {
        userData,
        currentUser
    } = useAuth();

    const {
        isOnline,
        saveToIndexedDB,
        getFromIndexedDB
    } = useSync();

    // ------------------------------------------------------------------------
    // Core fee state
    // ------------------------------------------------------------------------

    const [students, setStudents] =
        useState([]);

    const [balances, setBalances] =
        useState({});

    const [feeTransactions, setFeeTransactions] =
        useState([]);

    const [invoices, setInvoices] =
        useState([]);

    const [summary, setSummary] =
        useState(null);

    const [loading, setLoading] =
        useState(true);

    const [error, setError] =
        useState(null);

    const [scope, setScope] =
        useState({
            term: 'Term 1',
            year: new Date().getFullYear(),
            level: '',
            cls: ''
        });

    const [termLocked, setTermLocked] =
        useState(false);

    const [feeStructures, setFeeStructures] =
        useState([]);

    // ------------------------------------------------------------------------
    // Student pagination state
    // ------------------------------------------------------------------------

    const [studentSearch, setStudentSearch] =
        useState('');

    const [studentPageSize, setStudentPageSize] =
        useState(25);

    const [studentPage, setStudentPage] =
        useState(1);

    const [studentTotal, setStudentTotal] =
        useState(0);

    const [studentHasNextPage, setStudentHasNextPage] =
        useState(false);

    /*
     * Cursor for the currently loaded page.
     *
     * This is a Firestore DocumentSnapshot returned by getStudentsPage().
     */
    const [studentCursor, setStudentCursor] =
        useState(null);

    /*
     * Cursor history lets us navigate backwards.
     *
     * Example:
     *
     * page 1 -> []
     * page 2 -> [cursor after page 1]
     * page 3 -> [cursor after page 1, cursor after page 2]
     */
    const [studentCursorHistory, setStudentCursorHistory] =
        useState([]);

    // ------------------------------------------------------------------------
    // Load non-student fee data
    // ------------------------------------------------------------------------

    const loadFeeData = useCallback(
        async (overrideScope) => {
            let schoolId;

            try {
                schoolId =
                    requireSchoolId(
                        userData
                    );
            } catch (e) {
                setError(e.message);
                setLoading(false);
                return;
            }

            const s = {
                ...scope,
                ...(overrideScope || {})
            };

            setLoading(true);
            setError(null);

            try {
                // ------------------------------------------------------------
                // Offline cache
                // ------------------------------------------------------------

                const [
                    cTxn,
                    cInv,
                    cBal,
                    cStruct
                ] = await Promise.all([
                    getFromIndexedDB(
                        `txn_${schoolId}_${s.term}_${s.year}`
                    ),

                    getFromIndexedDB(
                        `inv_${schoolId}_${s.term}_${s.year}`
                    ),

                    getFromIndexedDB(
                        `bal_${schoolId}_${s.term}_${s.year}_${s.level}_${s.cls}`
                    ),

                    getFromIndexedDB(
                        `struct_${schoolId}_${s.year}`
                    )
                ]);

                if (cTxn?.length) {
                    setFeeTransactions(
                        cTxn
                    );
                }

                if (cInv?.length) {
                    setInvoices(
                        cInv
                    );
                }

                if (cBal?.length) {
                    setBalances(
                        Object.fromEntries(
                            cBal.map(
                                (b) => [
                                    b.studentId,
                                    b
                                ]
                            )
                        )
                    );
                }

                if (cStruct?.length) {
                    setFeeStructures(
                        cStruct
                    );
                }

                const locked =
                    await isTermLocked(
                        schoolId,
                        s.term,
                        s.year
                    ).catch(
                        () => false
                    );

                setTermLocked(
                    locked
                );

                // ------------------------------------------------------------
                // Online fee data
                //
                // Students are NOT loaded here.
                //
                // Students are loaded separately through loadStudentPage().
                // ------------------------------------------------------------

                if (isOnline) {
                    const [
                        txn,
                        inv,
                        bal,
                        sum,
                        structs
                    ] = await Promise.all([
                        getFeeTransactions(
                            schoolId,
                            {
                                term: s.term,
                                year: s.year
                            }
                        ).catch(
                            (err) => {
                                console.warn(
                                    'getFeeTransactions failed:',
                                    err
                                );

                                return [];
                            }
                        ),

                        getInvoices(
                            schoolId,
                            {
                                term: s.term,
                                year: s.year
                            }
                        ).catch(
                            (err) => {
                                console.warn(
                                    'getInvoices failed:',
                                    err
                                );

                                return [];
                            }
                        ),

                        getBalancesForSchool(
                            schoolId,
                            s.term,
                            s.year,
                            {
                                level:
                                    s.level,
                                cls:
                                    s.cls
                            }
                        ).catch(
                            (err) => {
                                console.warn(
                                    'getBalancesForSchool failed:',
                                    err
                                );

                                return [];
                            }
                        ),

                        getInvoiceSummary(
                            schoolId,
                            s.term,
                            s.year
                        ).catch(
                            () => null
                        ),

                        getFeeStructures(
                            schoolId,
                            {
                                year:
                                    s.year
                            }
                        ).catch(
                            () => []
                        )
                    ]);

                    setFeeTransactions(
                        txn || []
                    );

                    setInvoices(
                        inv || []
                    );

                    setBalances(
                        Object.fromEntries(
                            (
                                bal || []
                            ).map(
                                (b) => [
                                    b.studentId,
                                    b
                                ]
                            )
                        )
                    );

                    setSummary(
                        sum
                    );

                    setFeeStructures(
                        structs || []
                    );

                    await Promise.all([
                        saveToIndexedDB(
                            `txn_${schoolId}_${s.term}_${s.year}`,
                            txn || []
                        ),

                        saveToIndexedDB(
                            `inv_${schoolId}_${s.term}_${s.year}`,
                            inv || []
                        ),

                        saveToIndexedDB(
                            `bal_${schoolId}_${s.term}_${s.year}_${s.level}_${s.cls}`,
                            bal || []
                        ),

                        saveToIndexedDB(
                            `struct_${schoolId}_${s.year}`,
                            structs || []
                        )
                    ]);
                }
            } catch (err) {
                console.error(
                    'loadFeeData failed:',
                    err
                );

                setError(
                    err.message
                );
            } finally {
                setLoading(
                    false
                );
            }
        },
        [
            userData,
            scope,
            isOnline,
            saveToIndexedDB,
            getFromIndexedDB
        ]
    );

    // ------------------------------------------------------------------------
    // Load one student page
    // ------------------------------------------------------------------------

    const loadStudentPage = useCallback(
        async ({
            page = 1,
            cursor = null,
            overrideScope = {},
            overridePageSize
        } = {}) => {
            let schoolId;

            try {
                schoolId =
                    requireSchoolId(
                        userData
                    );
            } catch (e) {
                setError(
                    e.message
                );

                return;
            }

            const s = {
                ...scope,
                ...overrideScope
            };

            const size =
                Math.max(
                    1,
                    Math.floor(
                        Number(
                            overridePageSize ??
                                studentPageSize
                        ) || 25
                    )
                );

            setLoading(
                true
            );

            setError(
                null
            );

            try {
                // ------------------------------------------------------------
                // Offline
                // ------------------------------------------------------------

                if (!isOnline) {
                    const cached =
                        await getFromIndexedDB(
                            `students_page_${schoolId}_${s.level || 'all'}_${s.cls || 'all'}_${size}_${page}`
                        );

                    if (
                        cached?.students
                    ) {
                        setStudents(
                            cached.students
                        );

                        setStudentTotal(
                            Number(
                                cached.total
                            ) || 0
                        );

                        setStudentHasNextPage(
                            Boolean(
                                cached.hasNextPage
                            )
                        );

                        setStudentPage(
                            page
                        );

                        setStudentPageSize(
                            size
                        );

                        /*
                         * A Firestore DocumentSnapshot should not be persisted
                         * into IndexedDB. Therefore offline mode does not
                         * reconstruct a Firestore cursor.
                         */
                        setStudentCursor(
                            null
                        );

                        return;
                    }

                    setStudents(
                        []
                    );

                    setStudentHasNextPage(
                        false
                    );

                    setStudentPage(
                        page
                    );

                    setStudentCursor(
                        null
                    );

                    return;
                }

                // ------------------------------------------------------------
                // Firestore page + count
                // ------------------------------------------------------------

                const [
                    pageResult,
                    total
                ] = await Promise.all([
                    getStudentsPage(
                        schoolId,
                        {
                            level:
                                s.level,
                            cls:
                                s.cls,
                            pageSize:
                                size,
                            cursor
                        }
                    ),

                    page === 1
                        ? countStudents(
                              schoolId,
                              {
                                  level:
                                      s.level,
                                  cls:
                                      s.cls
                              }
                          )
                        : Promise.resolve(
                              studentTotal
                          )
                ]);

                // ------------------------------------------------------------
                // ONLY CURRENT PAGE IS STORED
                // ------------------------------------------------------------

                setStudents(
                    pageResult.students ||
                        []
                );

                setStudentTotal(
                    Number(
                        total
                    ) || 0
                );

                setStudentHasNextPage(
                    Boolean(
                        pageResult.hasNextPage
                    )
                );

                setStudentPage(
                    page
                );

                setStudentPageSize(
                    size
                );

                setStudentCursor(
                    pageResult.nextCursor ||
                        null
                );

                // ------------------------------------------------------------
                // Cache current page
                // ------------------------------------------------------------

                await saveToIndexedDB(
                    `students_page_${schoolId}_${s.level || 'all'}_${s.cls || 'all'}_${size}_${page}`,
                    {
                        students:
                            pageResult.students ||
                            [],

                        total:
                            Number(
                                total
                            ) || 0,

                        hasNextPage:
                            Boolean(
                                pageResult.hasNextPage
                            ),

                        /*
                         * Do not save Firestore DocumentSnapshot.
                         */
                        lastDocument:
                            null
                    }
                );
            } catch (err) {
                console.error(
                    'loadStudentPage failed:',
                    err
                );

                setError(
                    err.message
                );

                setStudents(
                    []
                );

                setStudentHasNextPage(
                    false
                );
            } finally {
                setLoading(
                    false
                );
            }
        },
        [
            userData,
            scope,
            isOnline,
            studentPageSize,
            studentTotal,
            saveToIndexedDB,
            getFromIndexedDB
        ]
    );

    // ------------------------------------------------------------------------
    // Reset pagination
    // ------------------------------------------------------------------------

    const resetStudentPagination =
        useCallback(
            async (
                overrideScope = {}
            ) => {
                setStudentPage(
                    1
                );

                setStudentCursor(
                    null
                );

                setStudentCursorHistory(
                    []
                );

                await loadStudentPage({
                    page: 1,
                    cursor: null,
                    overrideScope
                });
            },
            [
                loadStudentPage
            ]
        );

    // ------------------------------------------------------------------------
    // Next page
    // ------------------------------------------------------------------------

    const goToStudentNextPage =
        useCallback(
            async () => {
                if (
                    !studentHasNextPage ||
                    !studentCursor
                ) {
                    return;
                }

                setStudentCursorHistory(
                    (previous) => [
                        ...previous,
                        studentCursor
                    ]
                );

                await loadStudentPage({
                    page:
                        studentPage + 1,

                    cursor:
                        studentCursor
                });
            },
            [
                studentHasNextPage,
                studentCursor,
                studentPage,
                loadStudentPage
            ]
        );

    // ------------------------------------------------------------------------
    // Previous page
    // ------------------------------------------------------------------------

    const goToStudentPreviousPage =
        useCallback(
            async () => {
                if (
                    studentPage <= 1
                ) {
                    return;
                }

                const history = [
                    ...studentCursorHistory
                ];

                history.pop();

                const previousCursor =
                    history.length
                        ? history[
                              history.length -
                                  1
                          ]
                        : null;

                setStudentCursorHistory(
                    history
                );

                await loadStudentPage({
                    page:
                        studentPage - 1,

                    cursor:
                        previousCursor
                });
            },
            [
                studentPage,
                studentCursorHistory,
                loadStudentPage
            ]
        );

    // ------------------------------------------------------------------------
    // Change page size
    // ------------------------------------------------------------------------

    const setStudentPageSizeAndReload =
        useCallback(
            async (size) => {
                const nextSize =
                    Math.max(
                        1,
                        Math.floor(
                            Number(
                                size
                            ) || 25
                        )
                    );

                setStudentPageSize(
                    nextSize
                );

                setStudentPage(
                    1
                );

                setStudentCursor(
                    null
                );

                setStudentCursorHistory(
                    []
                );

                await loadStudentPage({
                    page: 1,
                    cursor: null,
                    overridePageSize:
                        nextSize
                });
            },
            [
                loadStudentPage
            ]
        );

    // ------------------------------------------------------------------------
    // Search current Firestore page
    // ------------------------------------------------------------------------

    const filteredStudents =
        useMemo(() => {
            const term =
                String(
                    studentSearch ||
                        ''
                )
                    .trim()
                    .toLowerCase();

            if (!term) {
                return students;
            }

            return students.filter(
                (student) => {
                    const values = [
                        student.firstName,
                        student.lastName,
                        student.otherNames,
                        student.fullName,
                        student.admissionNumber,
                        student.studentId,
                        student.class,
                        student.level
                    ];

                    return values.some(
                        (value) =>
                            String(
                                value ||
                                    ''
                            )
                                .toLowerCase()
                                .includes(
                                    term
                                )
                    );
                }
            );
        },
        [
            students,
            studentSearch
        ]
    );

    // ------------------------------------------------------------------------
    // Load fees when school/scope changes
    // ------------------------------------------------------------------------

    useEffect(() => {
        if (
            userData?.schoolId
        ) {
            loadFeeData();
        }

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        userData?.schoolId,
        scope.term,
        scope.year,
        scope.level,
        scope.cls
    ]);

    // ------------------------------------------------------------------------
    // Load first student page when pagination scope changes
    // ------------------------------------------------------------------------

    useEffect(() => {
        if (
            !userData?.schoolId
        ) {
            return;
        }

        setStudentPage(
            1
        );

        setStudentCursor(
            null
        );

        setStudentCursorHistory(
            []
        );

        setStudentSearch(
            ''
        );

        loadStudentPage({
            page: 1,
            cursor: null
        });

        // Pagination intentionally resets whenever
        // the Firestore student scope changes.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
        userData?.schoolId,
        scope.level,
        scope.cls,
        studentPageSize
    ]);

    // ------------------------------------------------------------------------
    // Invoice creation
    // ------------------------------------------------------------------------

    const createBulkInvoices =
        useCallback(
            async (
                entries,
                meta
            ) => {
                const schoolId =
                    requireSchoolId(
                        userData
                    );

                if (
                    termLocked
                ) {
                    return {
                        count: 0,
                        errors: [
                            {
                                error:
                                    'Term is locked'
                            }
                        ]
                    };
                }

                const enriched =
                    entries.map(
                        (
                            entry,
                            index
                        ) => ({
                            ...entry,

                            invoiceNumber:
                                entry.invoiceNumber ||
                                generateInvoiceNumber(
                                    schoolId,
                                    Date.now() +
                                        index
                                ),

                            suffix:
                                entry.suffix ||
                                `${Date.now()}_${index}`
                        })
                    );

                const results = {
                    count: 0,
                    errors: []
                };

                /*
                 * createInvoicesBatch internally respects Firestore's
                 * write-batch capacity. This is separate from student
                 * pagination.
                 */
                for (
                    let i = 0;
                    i <
                    enriched.length;
                    i += 500
                ) {
                    try {
                        const result =
                            await createInvoicesBatch(
                                schoolId,
                                enriched.slice(
                                    i,
                                    i + 500
                                ),
                                meta
                            );

                        results.count +=
                            result.count;
                    } catch (err) {
                        results.errors.push(
                            {
                                chunk: i,
                                error:
                                    err.message
                            }
                        );
                    }
                }

                setMemory(
                    `inv_${schoolId}_${meta.term}_${meta.year}_all_all`,
                    null,
                    0
                );

                await loadFeeData();

                return results;
            },
            [
                userData,
                termLocked,
                loadFeeData
            ]
        );

    // ------------------------------------------------------------------------
    // Record payment
    // ------------------------------------------------------------------------

    const addFeeTransaction =
        useCallback(
            async (
                txnData
            ) => {
                const schoolId =
                    requireSchoolId(
                        userData
                    );

                if (
                    termLocked
                ) {
                    return {
                        success:
                            false,

                        error:
                            'Term is locked'
                    };
                }

                try {
                    const result =
                        await postTransaction(
                            schoolId,
                            {
                                ...txnData,

                                recordedBy:
                                    currentUser?.uid,

                                recordedByName:
                                    userData?.fullName ||
                                    userData?.firstName ||
                                    'System'
                            },
                            {
                                performedBy:
                                    currentUser?.uid,

                                performedByName:
                                    userData?.fullName ||
                                    userData?.firstName ||
                                    'System'
                            }
                        );

                    setFeeTransactions(
                        (previous) => [
                            {
                                id:
                                    result.id,

                                ...txnData
                            },
                            ...previous
                        ]
                    );

                    return {
                        success:
                            true,

                        id:
                            result.id,

                        alreadyExisted:
                            result.alreadyExisted
                    };
                } catch (err) {
                    console.error(
                        'addFeeTransaction failed:',
                        err
                    );

                    return {
                        success:
                            false,

                        error:
                            err.message
                    };
                }
            },
            [
                userData,
                currentUser,
                termLocked
            ]
        );

    // ------------------------------------------------------------------------
    // Void transaction
    // ------------------------------------------------------------------------

    const voidTransactionById =
        useCallback(
            async (
                txnId,
                reason
            ) => {
                const schoolId =
                    requireSchoolId(
                        userData
                    );

                try {
                    await voidTransaction(
                        schoolId,
                        txnId,
                        reason,
                        currentUser?.uid,
                        userData?.fullName ||
                            userData?.firstName ||
                            'System'
                    );

                    await loadFeeData();

                    return {
                        success:
                            true
                    };
                } catch (err) {
                    return {
                        success:
                            false,

                        error:
                            err.message
                    };
                }
            },
            [
                userData,
                currentUser,
                loadFeeData
            ]
        );

    // ------------------------------------------------------------------------
    // Cancel invoice
    // ------------------------------------------------------------------------

    const cancelInvoiceById =
        useCallback(
            async (
                invoiceId,
                reason
            ) => {
                const schoolId =
                    requireSchoolId(
                        userData
                    );

                try {
                    await cancelInvoice(
                        schoolId,
                        invoiceId,
                        reason,
                        currentUser?.uid,
                        userData?.fullName ||
                            userData?.firstName ||
                            'System'
                    );

                    await loadFeeData();

                    return {
                        success:
                            true
                    };
                } catch (err) {
                    return {
                        success:
                            false,

                        error:
                            err.message
                    };
                }
            },
            [
                userData,
                currentUser,
                loadFeeData
            ]
        );

    // ------------------------------------------------------------------------
    // Overdue
    // ------------------------------------------------------------------------

    const checkOverdueInvoices =
        useCallback(
            async () => {
                const now =
                    new Date();

                const overdue =
                    invoices.filter(
                        (invoice) =>
                            invoice.status !==
                                'paid' &&
                            invoice.status !==
                                'cancelled' &&
                            invoice.status !==
                                'overdue' &&
                            invoice.dueDate &&
                            new Date(
                                invoice.dueDate
                            ) < now
                    );

                if (
                    !overdue.length
                ) {
                    return 0;
                }

                setInvoices(
                    (previous) =>
                        previous.map(
                            (invoice) =>
                                overdue.find(
                                    (item) =>
                                        item.id ===
                                        invoice.id
                                )
                                    ? {
                                          ...invoice,
                                          status:
                                              'overdue'
                                      }
                                    : invoice
                        )
                );

                return overdue.length;
            },
            [
                invoices
            ]
        );

    // ------------------------------------------------------------------------
    // Lookups
    // ------------------------------------------------------------------------

    const getStudentBalance =
        useCallback(
            (studentId) =>
                balances[
                    studentId
                ] || null,
            [
                balances
            ]
        );

    const getStudentInvoices =
        useCallback(
            (
                studentId,
                opts = {}
            ) =>
                invoices
                    .filter(
                        (invoice) =>
                            invoice.studentId ===
                                studentId &&
                            (
                                opts.includeCancelled ||
                                invoice.status !==
                                    'cancelled'
                            )
                    )
                    .sort(
                        (a, b) =>
                            new Date(
                                b.createdAt
                                    ?.toDate?.() ||
                                    b.createdAt
                            ) -
                            new Date(
                                a.createdAt
                                    ?.toDate?.() ||
                                    a.createdAt
                            )
                    ),
            [
                invoices
            ]
        );

    const getInvoiceStats =
        useCallback(
            () => {
                const total =
                    invoices.length;

                const paid =
                    invoices.filter(
                        (invoice) =>
                            invoice.status ===
                            'paid'
                    ).length;

                const overdue =
                    invoices.filter(
                        (invoice) =>
                            invoice.status ===
                            'overdue'
                    ).length;

                const pending =
                    invoices.filter(
                        (invoice) =>
                            invoice.status ===
                                'pending' ||
                            invoice.status ===
                                'partial'
                    ).length;

                const totalAmount =
                    invoices.reduce(
                        (
                            sum,
                            invoice
                        ) =>
                            sum +
                            (
                                Number(
                                    invoice.total
                                ) || 0
                            ),
                        0
                    );

                const paidAmount =
                    invoices.reduce(
                        (
                            sum,
                            invoice
                        ) =>
                            sum +
                            (
                                Number(
                                    invoice.paidAmount
                                ) || 0
                            ),
                        0
                    );

                return {
                    total,
                    paid,
                    overdue,
                    pending,
                    draft: 0,
                    totalAmount,
                    paidAmount,
                    outstandingAmount:
                        totalAmount -
                        paidAmount
                };
            },
            [
                invoices
            ]
        );

    const aging =
        useMemo(
            () =>
                computeAging(
                    invoices
                ),
            [
                invoices
            ]
        );

    // ------------------------------------------------------------------------
    // Invoice reminder
    // ------------------------------------------------------------------------

    const sendInvoiceReminder =
        useCallback(
            async (
                invoiceId
            ) => {
                try {
                    const response =
                        await fetch(
                            '/api/send-invoice-reminder',
                            {
                                method:
                                    'POST',

                                headers: {
                                    'Content-Type':
                                        'application/json'
                                },

                                body:
                                    JSON.stringify(
                                        {
                                            invoiceId,
                                            schoolId:
                                                userData?.schoolId
                                        }
                                    )
                            }
                        );

                    const data =
                        await response.json();

                    return data.success
                        ? {
                              success:
                                  true
                          }
                        : {
                              success:
                                  false,

                              error:
                                  data.error
                          };
                } catch (err) {
                    return {
                        success:
                            false,

                        error:
                            err.message
                    };
                }
            },
            [
                userData
            ]
        );

    // ------------------------------------------------------------------------
    // Fee structure
    // ------------------------------------------------------------------------

    const saveFeeStructureAction =
        useCallback(
            async (
                targetKey,
                year,
                structure,
                term = 'all'
            ) => {
                const schoolId =
                    requireSchoolId(
                        userData
                    );

                const result =
                    await upsertFeeStructure(
                        schoolId,
                        targetKey,
                        year,
                        structure,
                        {
                            updatedBy:
                                currentUser?.uid,

                            updatedByName:
                                userData?.fullName ||
                                userData?.firstName ||
                                'System'
                        },
                        term
                    );

                await loadFeeData();

                return result;
            },
            [
                userData,
                currentUser,
                loadFeeData
            ]
        );

    const deleteFeeStructureAction =
        useCallback(
            async (
                id
            ) => {
                const schoolId =
                    requireSchoolId(
                        userData
                    );

                const result =
                    await deleteFeeStructure(
                        schoolId,
                        id
                    );

                await loadFeeData();

                return result;
            },
            [
                userData,
                loadFeeData
            ]
        );

    // ------------------------------------------------------------------------
    // Reconcile balance
    // ------------------------------------------------------------------------

    const reconcileBalanceAction =
        useCallback(
            async (
                studentId,
                term,
                year
            ) => {
                const schoolId =
                    requireSchoolId(
                        userData
                    );

                const result =
                    await reconcileStudentBalance(
                        schoolId,
                        studentId,
                        term,
                        year
                    );

                await loadFeeData();

                return result;
            },
            [
                userData,
                loadFeeData
            ]
        );

    // ------------------------------------------------------------------------
    // Context value
    // ------------------------------------------------------------------------

    const value = {
        /*
         * IMPORTANT:
         *
         * students contains ONLY the current Firestore page.
         *
         * Fees.jsx must render this array directly.
         */
        students:
            filteredStudents,

        /*
         * Raw current Firestore page.
         *
         * This is intentionally NOT the complete school student list.
         */
        allLoadedStudents:
            students,

        // Student search
        studentSearch,
        setStudentSearch,

        // Student pagination
        studentPage,
        studentPageSize,
        studentTotal,
        studentHasNextPage,

        studentTotalPages:
            Math.max(
                1,
                Math.ceil(
                    studentTotal /
                        studentPageSize
                )
            ),

        loadStudentPage,

        resetStudentPagination,

        goToStudentNextPage,

        goToStudentPreviousPage,

        setStudentPage:
            setStudentPage,

        setStudentPageSize:
            setStudentPageSizeAndReload,

        // Fee data
        feeBalances:
            balances,

        feeTransactions,

        invoices,

        loading,

        error,

        scope,

        setScope,

        summary,

        termLocked,

        aging,

        feeStructures,

        // ------------------------------------------------------------
        // Invoice API
        // ------------------------------------------------------------

        createInvoice:
            async (data) => {
                const result =
                    await createBulkInvoices(
                        [data],
                        {
                            term:
                                data.term,

                            year:
                                data.academicYear,

                            createdBy:
                                currentUser?.uid,

                            createdByName:
                                userData?.fullName ||
                                ''
                        }
                    );

                return {
                    success:
                        result.count >
                        0,

                    error:
                        result.errors[0]
                            ?.error
                };
            },

        createBulkInvoices,

        // ------------------------------------------------------------
        // Transactions
        // ------------------------------------------------------------

        addFeeTransaction,

        voidTransaction:
            voidTransactionById,

        cancelInvoice:
            cancelInvoiceById,

        // ------------------------------------------------------------
        // Other operations
        // ------------------------------------------------------------

        sendInvoiceReminder,

        checkOverdueInvoices,

        getStudentInvoices,

        getInvoiceStats,

        getStudentBalance,

        saveFeeStructure:
            saveFeeStructureAction,

        deleteFeeStructure:
            deleteFeeStructureAction,

        reconcileBalance:
            reconcileBalanceAction,

        refreshData:
            () =>
                loadFeeData(),

        loadFeeData
    };

    return (
        <FeeContext.Provider
            value={value}
        >
            {children}
        </FeeContext.Provider>
    );
}
