const Timer = require('../util/timer');
const Thread = require('./thread');
const execute = require('./execute.js');

/**
 * Profiler frame name for stepping a single thread.
 * @const {string}
 */
const stepThreadProfilerFrame = 'Sequencer.stepThread';

/**
 * Profiler frame name for the inner loop of stepThreads.
 * @const {string}
 */
const stepThreadsInnerProfilerFrame = 'Sequencer.stepThreads#inner';

/**
 * Profiler frame name for execute.
 * @const {string}
 */
const executeProfilerFrame = 'execute';

/**
 * Profiler frame ID for stepThreadProfilerFrame.
 * @type {number}
 */
let stepThreadProfilerId = -1;

/**
 * Profiler frame ID for stepThreadsInnerProfilerFrame.
 * @type {number}
 */
let stepThreadsInnerProfilerId = -1;

/**
 * Profiler frame ID for executeProfilerFrame.
 * @type {number}
 */
let executeProfilerId = -1;

class Sequencer {
    constructor (runtime) {
        /**
         * A utility timer for timing thread sequencing.
         * @type {!Timer}
         */
        this.timer = new Timer();

        /**
         * Reference to the runtime owning this sequencer.
         * @type {!Runtime}
         */
        this.runtime = runtime;

        this.activeThread = null;
    }

    /**
     * Time to run a warp-mode thread, in ms.
     * @type {number}
     */
    static get WARP_TIME () {
        return 500;
    }

    /**
     * Step through all threads in `this.runtime.threads`, running them in order.
     * @return {Array.<!Thread>} List of inactive threads after stepping.
     */
    stepThreads () {
        // Work time is 75% of the thread stepping interval.
        const WORK_TIME = 0.75 * this.runtime.currentStepTime;
        // For compatibility with Scatch 2, update the millisecond clock
        // on the Runtime once per step (see Interpreter.as in Scratch 2
        // for original use of `currentMSecs`)
        this.runtime.updateCurrentMSecs();
        // Start counting toward WORK_TIME.
        this.timer.start();
        // Count of active threads.
        let numActiveThreads = Infinity;
        // Whether `stepThreads` has run through a full single tick.
        let ranFirstTick = false;
        const doneThreads = [];
        // Conditions for continuing to stepping threads:
        // 1. We must have threads in the list, and some must be active.
        // 2. Time elapsed must be less than WORK_TIME.
        // 3. Either turbo mode, or no redraw has been requested by a primitive.
        while (this.runtime.threads.length > 0 &&
               numActiveThreads > 0 &&
               this.timer.timeElapsed() < WORK_TIME &&
               (this.runtime.turboMode || !this.runtime.redrawRequested)) {
            if (this.runtime.profiler !== null) {
                if (stepThreadsInnerProfilerId === -1) {
                    stepThreadsInnerProfilerId = this.runtime.profiler.idByName(stepThreadsInnerProfilerFrame);
                }
                this.runtime.profiler.start(stepThreadsInnerProfilerId);
            }

            numActiveThreads = 0;
            let stoppedThread = false;

            let shouldStep = (!this.runtime.singleStepMode || this.runtime.doStep);
            if(!shouldStep) {
                break;
            }

            // update doStep if necessary - one step each one step for each active thread
            // since singleStepMode is true, stepThread() will only run one block in each thread before returning
            if(this.runtime.singleStepMode && this.runtime.doStep) {
                this.runtime.doStep = false;
                console.log("stepThreads(): Stepping.");
            }

            // Attempt to run each thread one time.
            const threads = this.runtime.threads;
            for (let i = 0; i < threads.length; i++) {
                const activeThread = this.activeThread = threads[i];

                
                // Check if the thread is done so it is not executed.
                if (activeThread.stack.length === 0 ||
                    activeThread.status === Thread.STATUS_DONE) {
                    // Finished with this thread.
                    stoppedThread = true;
                    continue;
                }
                if (activeThread.status === Thread.STATUS_YIELD_TICK &&
                    !ranFirstTick) {
                    // Clear single-tick yield from the last call of `stepThreads`.
                    activeThread.status = Thread.STATUS_RUNNING;
                }

                // Handle runnable threads
                if (activeThread.status === Thread.STATUS_RUNNING ||
                    activeThread.status === Thread.STATUS_YIELD) {

                    // Single-step mode has special conditions for running a thread. 
                    // We keep track of the thread currently being stepped through, and defer stepping any other threads until the
                    // current thread has completed stepping.
                    // (This emulates the way multiple threads are executed when run normally.)
                    if (this.runtime.singleStepMode){
                        // Initially, there is no current thread for single-stepping. So we set it to the first runnable thread we encounter here.
                        if (this.runtime.currentThreadRef == null) {
                            this.runtime.nextThreadIndex = i;
                            this.runtime.currentThreadRef = activeThread;
                        }

                        if (activeThread != this.runtime.currentThreadRef) {
                            // If not the current thread, skip it
                            continue;
                        } else { 
                            console.log("Found matching thread for nextThreadIndex: %d", this.runtime.nextThreadIndex);
                            // Otherwise, continue on to step the thread below.
                        }
                    } 


                    // Normal-mode thread: step.
                    if (this.runtime.profiler !== null) {
                        if (stepThreadProfilerId === -1) {
                            stepThreadProfilerId = this.runtime.profiler.idByName(stepThreadProfilerFrame);
                        }

                        // Increment the number of times stepThread is called.
                        this.runtime.profiler.increment(stepThreadProfilerId);
                    }
                    this.stepThread(activeThread);
                    
                    // check if current thread finished
                    if (this.runtime.currentThreadRef == null) {
                        // set to next active thread (search threads list starting after current thread, and wrap around)
                        // TODO(bdnwang): loop condition: check correctness / cleaniness
                        for (let offset = 0; offset < threads.length; offset++) {
                            const nextIndex = (i+1) + offset;
                            nextIndex = nextIndex % threads.length;
                            const nextThread = threads[nextIndex];
                            if (nextThread.status === Thread.STATUS_RUNNING ||
                                nextThread.status === Thread.STATUS_YIELD) {
                                    this.runtime.currentThreadRef = nextThread;
                                    this.runtime.nextThreadIndex = nextIndex;
                                    break;
                                }
                        }
                    }

                    activeThread.warpTimer = null;
                    if (activeThread.isKilled) {
                        i--; // if the thread is removed from the list (killed), do not increase index
                    }
                }
                if (activeThread.status === Thread.STATUS_RUNNING) {
                    numActiveThreads++;
                }
                // Check if the thread completed while it just stepped to make
                // sure we remove it before the next iteration of all threads.
                if (activeThread.stack.length === 0 ||
                    activeThread.status === Thread.STATUS_DONE) {
                    // Finished with this thread.
                    stoppedThread = true;
            
                    // // TODO: this may yield divergent behavior from normal execution, because if currentThreadRef = null
                    // // it will set the first occuring active thread to be the next current thread.
                    // // Consider the case where threads[0] = unactive, threads[1] = active, threads[2] = active upon startup
                    // // - current thread will first be set to threads[1] and run to its first yield point
                    // // - the next thread to be run, in normal execution would be thread[2]
                    // // - but in single step mode, IF thread[0] becomes runnable in the meantime, we would instead set thread[0] to be the currnet thread. NOT thread[2]
                    // if (this.runtime.singleStepMode) {
                    //     this.runtime.currentThreadRef = null;
                    //     this.runtime.nextThreadIndex = null;
                    // }
                }

                // if we're in single step mode and got here, that means we executed a step on the current thread
                if (this.runtime.singleStepMode) {
                    break;
                }

                
            }
            // We successfully ticked once. Prevents running STATUS_YIELD_TICK
            // threads on the next tick.
            ranFirstTick = true;

            if (this.runtime.profiler !== null) {
                this.runtime.profiler.stop();
            }

            // Filter inactive threads from `this.runtime.threads`.
            if (stoppedThread) {
                let nextActiveThread = 0;
                for (let i = 0; i < this.runtime.threads.length; i++) {
                    const thread = this.runtime.threads[i];
                    if (thread.stack.length !== 0 &&
                        thread.status !== Thread.STATUS_DONE) {
                        this.runtime.threads[nextActiveThread] = thread;
                        nextActiveThread++;
                    } else {
                        doneThreads.push(thread);
                    }
                }
                this.runtime.threads.length = nextActiveThread;
            }
        }

        this.activeThread = null;

        return doneThreads;
    }

    /**
     * Step the requested thread for as long as necessary.
     * 
     * In this.runtime.singleStepMode, immediately returns after stepping one block.
     * @param {!Thread} thread Thread object to step.
     */
    stepThread (thread) {
        let currentBlockId = thread.peekStack();
        if (!currentBlockId) {
            // A "null block" - empty branch.
            thread.popStack();

            // Did the null follow a hat block?
            if (thread.stack.length === 0) {
                thread.status = Thread.STATUS_DONE;
                return;
            }
        }
        console.log("stepThread(): new call for thread %o.", thread);
        // Save the current block ID to notice if we did control flow.
        while ((currentBlockId = thread.peekStack())) {
            console.log("stepThread(): running next block.");
            let isWarpMode = thread.peekStackFrame().warpMode;
            if (isWarpMode && !thread.warpTimer) {
                // Initialize warp-mode timer if it hasn't been already.
                // This will start counting the thread toward `Sequencer.WARP_TIME`.
                thread.warpTimer = new Timer();
                thread.warpTimer.start();
            }
            // Execute the current block.
            if (this.runtime.profiler !== null) {
                if (executeProfilerId === -1) {
                    executeProfilerId = this.runtime.profiler.idByName(executeProfilerFrame);
                }

                // Increment the number of times execute is called.
                this.runtime.profiler.increment(executeProfilerId);
            }
            if (thread.target === null) {
                this.retireThread(thread);
            } else {
                execute(this, thread);

                // Handle breakpoint blocks
                let currentBlock = thread.blockContainer.getBlock(currentBlockId);
                if (currentBlock != null && this.runtime.breakpointsEnabled &&currentBlock.opcode == "control_breakpoint") {
                    console.log("stepThread(): BREAKPOINT");
                    
                    // start single stepping this thread
                    // this.runtime.singleStepMode = true; // does this trigger a React props update?
                    this.runtime.setSingleStepMode(true);
                    this.runtime.currentThreadRef = thread; 
                }
                
            }
            thread.blockGlowInFrame = currentBlockId;
            
            // TODO(bdnwang): trying to add glow for paused block
            // this.runtime.glowBlock(currentBlockId, true);
            
            // If the thread has yielded or is waiting, yield to other threads.
            if (thread.status === Thread.STATUS_YIELD) {
                // Mark as running for next iteration.
                thread.status = Thread.STATUS_RUNNING;
                // In warp mode, yielded blocks are re-executed immediately.
                if (isWarpMode &&
                    thread.warpTimer.timeElapsed() <= Sequencer.WARP_TIME) {
                    continue;
                }

                // In single-stepping mode, we are done stepping this thread at the moment
                this.runtime.currentThreadRef = null;
                return;
            } else if (thread.status === Thread.STATUS_PROMISE_WAIT) {
                // A promise was returned by the primitive. Yield the thread
                // until the promise resolves. Promise resolution should reset
                // thread.status to Thread.STATUS_RUNNING.

                // In single-stepping mode, we are done stepping this thread at the moment
                this.runtime.currentThreadRef = null;
                return;
            } else if (thread.status === Thread.STATUS_YIELD_TICK) {
                // stepThreads will reset the thread to Thread.STATUS_RUNNING
                
                // In single-stepping mode, we are done stepping this thread at the moment
                this.runtime.currentThreadRef = null;
                return;
            }
            // If no control flow has happened, switch to next block.
            if (thread.peekStack() === currentBlockId) {
                thread.goToNextBlock();
            }
            // If no next block has been found at this point, look on the stack.
            while (!thread.peekStack()) {
                thread.popStack();

                if (thread.stack.length === 0) {
                    // No more stack to run!
                    thread.status = Thread.STATUS_DONE;
                    console.log("stepThread(): no more stack to run, exiting.");

                    // In single-stepping mode, we are done stepping this thread at the moment
                    this.runtime.currentThreadRef = null;
                    return;
                }

                console.log("stepThread(): no next block found.");

                const stackFrame = thread.peekStackFrame();
                isWarpMode = stackFrame.warpMode;

                if (stackFrame.isLoop) {
                    // The current level of the stack is marked as a loop.
                    // Return to yield for the frame/tick in general.
                    // Unless we're in warp mode - then only return if the
                    // warp timer is up.
                    if (!isWarpMode ||
                        thread.warpTimer.timeElapsed() > Sequencer.WARP_TIME) {
                        // Don't do anything to the stack, since loops need
                        // to be re-executed.

                        // In single-stepping mode, we are done stepping this thread at the moment
                        this.runtime.currentThreadRef = null;
                        return;
                    }
                    // Don't go to the next block for this level of the stack,
                    // since loops need to be re-executed.
                    continue;

                } else if (stackFrame.waitingReporter) {
                    // This level of the stack was waiting for a value.
                    // This means a reporter has just returned - so don't go
                    // to the next block for this level of the stack.
                    
                    // TODO(bdnwang): I'm not sure what's this for
                    // In single-stepping mode, we are done stepping this thread at the moment
                    this.runtime.currentThreadRef = null;
                    return;
                }
                // Get next block of existing block on the stack.
                thread.goToNextBlock();
            }

            // if the single step flag is set then stop here, only execute one block at a time
            console.log("singleStepMode: "+this.runtime.singleStepMode);
            if (this.runtime.singleStepMode) {
                console.log("stepThread(): single step short circuit, exiting.");

                // do NOT clear this.runtime.currentThreadRef
                // we want to keep executing this thread until we hit a stopping point, so currenThreadRef should still be set to this thread
                return;
            } 
        }
    }

    /**
     * Step a thread into a block's branch.
     * @param {!Thread} thread Thread object to step to branch.
     * @param {number} branchNum Which branch to step to (i.e., 1, 2).
     * @param {boolean} isLoop Whether this block is a loop.
     */
    stepToBranch (thread, branchNum, isLoop) {
        if (!branchNum) {
            branchNum = 1;
        }
        const currentBlockId = thread.peekStack();
        const branchId = thread.target.blocks.getBranch(
            currentBlockId,
            branchNum
        );
        thread.peekStackFrame().isLoop = isLoop;
        if (branchId) {
            // Push branch ID to the thread's stack.
            thread.pushStack(branchId);
        } else {
            thread.pushStack(null);
        }
    }

    /**
     * Step a procedure.
     * @param {!Thread} thread Thread object to step to procedure.
     * @param {!string} procedureCode Procedure code of procedure to step to.
     */
    stepToProcedure (thread, procedureCode) {
        const definition = thread.target.blocks.getProcedureDefinition(procedureCode);
        if (!definition) {
            return;
        }
        // Check if the call is recursive.
        // If so, set the thread to yield after pushing.
        const isRecursive = thread.isRecursiveCall(procedureCode);
        // To step to a procedure, we put its definition on the stack.
        // Execution for the thread will proceed through the definition hat
        // and on to the main definition of the procedure.
        // When that set of blocks finishes executing, it will be popped
        // from the stack by the sequencer, returning control to the caller.
        thread.pushStack(definition);
        // In known warp-mode threads, only yield when time is up.
        if (thread.peekStackFrame().warpMode &&
            thread.warpTimer.timeElapsed() > Sequencer.WARP_TIME) {
            thread.status = Thread.STATUS_YIELD;
        } else {
            // Look for warp-mode flag on definition, and set the thread
            // to warp-mode if needed.
            const definitionBlock = thread.target.blocks.getBlock(definition);
            const innerBlock = thread.target.blocks.getBlock(
                definitionBlock.inputs.custom_block.block);
            let doWarp = false;
            if (innerBlock && innerBlock.mutation) {
                const warp = innerBlock.mutation.warp;
                if (typeof warp === 'boolean') {
                    doWarp = warp;
                } else if (typeof warp === 'string') {
                    doWarp = JSON.parse(warp);
                }
            }
            if (doWarp) {
                thread.peekStackFrame().warpMode = true;
            } else if (isRecursive) {
                // In normal-mode threads, yield any time we have a recursive call.
                thread.status = Thread.STATUS_YIELD;
            }
        }
    }

    /**
     * Retire a thread in the middle, without considering further blocks.
     * @param {!Thread} thread Thread object to retire.
     */
    retireThread (thread) {
        thread.stack = [];
        thread.stackFrame = [];
        thread.requestScriptGlowInFrame = false;
        thread.status = Thread.STATUS_DONE;
    }
}

module.exports = Sequencer;
